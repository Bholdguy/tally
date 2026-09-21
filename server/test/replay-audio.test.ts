// Step 8, audio tier: stored PCM streamed at 1x through FRESH live sessions (mock Voice Agent + mock streaming STT here; the live
// smoke against the real APIs is scripts/replay-case.ts). Reported "k/3 passed"; never "deterministic".
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Secret } from '@tally/agent';
import { initDatabase } from '@tally/db';
import { Store } from '@tally/reliability';
import { buildApp } from '../src/app.js';
import { runAudioReplay } from '../src/replay-audio.js';
import { SessionRuntime } from '../src/runtime.js';
import { mockAgent, mockStt, tone, wait, type MockAgent } from './mocks.js';

const TOKEN = ['operator', 'token', '0123456789'].join('-');
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function world() {
  const agent = await mockAgent(); const stt = await mockStt();
  const dir = mkdtempSync(join(tmpdir(), 'tally-ra-'));
  initDatabase(join(dir, 't.sqlite'));
  const store = new Store(join(dir, 't.sqlite'));
  const start = (mode: 'demo' | 'replay' | 'live' = 'demo') => SessionRuntime.start({
    agentConfig: { apiKey: new Secret('k-0000000'), wsUrl: agent.url, restUrl: 'http://x' }, store, audioDir: join(dir, 'audio'), mode, stt: { url: stt.url },
  });
  cleanups.push(async () => { store.close(); await agent.close(); await stt.close(); });
  return { agent, stt, store, start };
}
type World = Awaited<ReturnType<typeof world>>;
const call = (agent: MockAgent, id: string, args: unknown) => agent.push({ type: 'tool.call', call_id: id, name: 'add_item', arguments: args });

/** A real resolved case through the real runtime: stale call held, "yes three" -> re-validated commit. */
async function resolvedCase(w: World) {
  const rt = await w.start('demo');
  await rt.sendPcm(tone(200)); await rt.sendPcm(new Uint8Array(33600));
  w.stt.speechStarted(); w.stt.final('Two burgers, no wait, make it three.', 0);
  await wait(60);
  call(w.agent, 'o1', { item_id: 'burger', quantity: 2, modifiers: [] });
  expect(await w.agent.result('o1')).toMatchObject({ status: 'HELD' });
  w.stt.final('Yes, three.', 1); await wait(60);
  call(w.agent, 'o2', { item_id: 'burger', quantity: 3, modifiers: [] });
  expect(await w.agent.result('o2')).toMatchObject({ status: 'OK' });
  await rt.end();
  const id = w.store.listCases({ session_id: rt.session_id })[0]!.id;
  return { id, session: rt.session_id, audioMs: 200 + 700 };
}

/** startRuntime for a replay attempt: the "agent" behaves as scripted per attempt (correct or stale), as the managed LLM might. */
function scripted(w: World, behave: (n: number) => 'correct' | 'stale' | 'none' | 'startfail') {
  let n = 0;
  return async (b: { mode?: 'live' | 'demo' | 'replay' }) => {
    const attempt = ++n;
    const how = behave(attempt);
    if (how === 'startfail') throw new Error('could not start');
    const rt = await w.start(b.mode ?? 'replay');
    void (async () => {
      await wait(1000);
      w.stt.speechStarted(); w.stt.final('Two burgers, no wait, make it three.', 0);
      await wait(60);
      if (how === 'none') return;
      call(w.agent, `r${attempt}-${rt.session_id}`, { item_id: 'burger', quantity: how === 'correct' ? 3 : 2, modifiers: [] });
    })();
    return rt;
  };
}

describe('audio-tier replay through fresh live sessions', () => {
  it('3/3 passed: streams the stored PCM at 1x, three separate replay-mode sessions, judged on the FINAL order vs the expected state', async () => {
    const w = await world();
    const c = await resolvedCase(w);
    const liveOrder = JSON.stringify(w.store.getOrder(c.session));
    const casesBefore = w.store.listCases().length;
    const t0 = Date.now();
    const rep = await runAudioReplay({ store: w.store, caseId: c.id, startRuntime: scripted(w, () => 'correct'), settleMs: 500 });
    const took = Date.now() - t0;
    expect(rep).toMatchObject({ tier: 'audio', k: 3, passed: 3, overall: 'pass', label: '3/3 passed' });
    expect(took).toBeGreaterThanOrEqual(3 * c.audioMs);
    const runs = w.store.listReplayRuns(c.id);
    expect(runs.map((r) => [r.tier, r.attempt_k, r.result])).toEqual([['audio', 1, 'pass'], ['audio', 2, 'pass'], ['audio', 3, 'pass']]);
    expect(new Set(runs.map((r) => r.suite_run_id)).size).toBe(1);
    const sessions = rep.attempts.map((a) => a.session_id!);
    expect(new Set(sessions).size).toBe(3);
    for (const s of sessions) expect(w.store.sessionAudio(s)!.mode).toBe('replay');
    expect(JSON.stringify(w.store.getOrder(c.session))).toBe(liveOrder);
    expect(w.store.listCases().length).toBe(casesBefore);
    expect(rep.label).not.toMatch(/determin/i);
  }, 30000);

  it('2/3 passed is a FAIL: the one bad run is reported, never averaged away', async () => {
    const w = await world();
    const c = await resolvedCase(w);
    const rep = await runAudioReplay({ store: w.store, caseId: c.id, startRuntime: scripted(w, (n) => (n === 2 ? 'stale' : 'correct')), settleMs: 400 });
    expect(rep).toMatchObject({ passed: 2, k: 3, overall: 'fail', label: '2/3 passed: FAIL' });
    expect(rep.attempts.map((a) => a.result)).toEqual(['pass', 'fail', 'pass']);
    expect(rep.attempts[1]!.diff).toMatchObject({ equal: false, actual_lines: [] });
  }, 30000);

  it('a run where the agent never calls the tool, and a run that cannot start, both count as FAIL (recorded, not dropped)', async () => {
    const w = await world();
    const c = await resolvedCase(w);
    const rep = await runAudioReplay({ store: w.store, caseId: c.id, startRuntime: scripted(w, (n) => (n === 1 ? 'none' : n === 2 ? 'startfail' : 'correct')), settleMs: 400 });
    expect(rep.attempts.map((a) => a.result)).toEqual(['fail', 'fail', 'pass']);
    expect(rep.attempts[1]!.diff).toMatchObject({ error: 'could not start' });
    expect(w.store.listReplayRuns(c.id)).toHaveLength(3);
    expect(rep.label).toBe('1/3 passed: FAIL');
  }, 30000);

  it('refuses what it cannot judge: no expected state (escalated), unknown case, bad k', async () => {
    const w = await world();
    const rt = await w.start('demo');
    await rt.sendPcm(tone(100));
    w.stt.speechStarted(); w.stt.final('Three burgers.', 0); await wait(60);
    for (let i = 0; i < 3; i++) { call(w.agent, `e${i}`, { item_id: 'burger', quantity: 2, modifiers: [] }); await w.agent.result(`e${i}`); }
    await rt.end();
    const esc = w.store.listCases({ session_id: rt.session_id }).at(-1)!.id;
    expect(w.store.getCase(esc)!.expected_state_json).toBeNull();
    const dead = async () => { throw new Error('must not start'); };
    await expect(runAudioReplay({ store: w.store, caseId: esc, startRuntime: dead })).rejects.toMatchObject({ code: 'no_expected_state' });
    await expect(runAudioReplay({ store: w.store, caseId: 'nope', startRuntime: dead })).rejects.toMatchObject({ code: 'case_not_found' });
    await expect(runAudioReplay({ store: w.store, caseId: esc, startRuntime: dead, k: 0 })).rejects.toThrow(RangeError);
  }, 30000);
});

describe('replay API', () => {
  async function api() {
    const w = await world();
    const c = await resolvedCase(w);
    const { app } = await buildApp({ operatorToken: TOKEN, cases: w.store, replaySettleMs: 400, startRuntime: scripted(w, () => 'correct') });
    await app.listen({ host: '127.0.0.1', port: 0 });
    cleanups.push(async () => { await app.close(); });
    const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
    return { w, c, base, H: { 'x-tally-operator': TOKEN } };
  }

  it('token required; unknown tier / case handled', async () => {
    const { c, base, H } = await api();
    expect((await fetch(`${base}/api/cases/${c.id}/replay?tier=evidence`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${base}/api/cases/${c.id}/replay?tier=nope`, { method: 'POST', headers: H })).status).toBe(400);
    expect((await fetch(`${base}/api/cases/nope/replay?tier=evidence`, { method: 'POST', headers: H })).status).toBe(404);
    expect((await fetch(`${base}/api/cases/nope/replays`, { headers: H })).status).toBe(404);
  });

  it('evidence tier: synchronous "PASS (deterministic)"; audio tier: 202, polled, "3/3 passed"; both listed with their own wording', async () => {
    const { c, base, H } = await api();
    const ev = await (await fetch(`${base}/api/cases/${c.id}/replay?tier=evidence`, { method: 'POST', headers: H })).json() as any;
    expect(ev).toMatchObject({ tier: 'evidence', result: 'pass', label: 'PASS (deterministic)' });
    const ev2 = await (await fetch(`${base}/api/cases/${c.id}/replay?tier=evidence`, { method: 'POST', headers: H })).json() as any;
    expect(JSON.stringify(ev2.diff)).toBe(JSON.stringify(ev.diff));

    const r = await fetch(`${base}/api/cases/${c.id}/replay?tier=audio`, { method: 'POST', headers: H });
    expect(r.status).toBe(202);
    const { suite_run_id } = await r.json() as { suite_run_id: string };
    expect((await fetch(`${base}/api/cases/${c.id}/replay?tier=audio`, { method: 'POST', headers: H })).status).toBe(409);
    let job: any;
    for (let i = 0; i < 300; i++) { job = await (await fetch(`${base}/api/replays/${suite_run_id}`, { headers: H })).json(); if (job.status !== 'running') break; await wait(100); }
    expect(job.status).toBe('done');
    expect(job.report).toMatchObject({ label: '3/3 passed', overall: 'pass' });

    const list = await (await fetch(`${base}/api/cases/${c.id}/replays`, { headers: H })).json() as any;
    expect(list.latest_evidence).toBe('PASS (deterministic)');
    expect(list.audio_suites).toEqual([expect.objectContaining({ suite_run_id, label: '3/3 passed', k: 3, passed: 3 })]);
    expect(JSON.stringify(list.audio_suites)).not.toMatch(/determin/i);
    expect(list.runs.filter((x: any) => x.tier === 'evidence')).toHaveLength(2);
    expect(list.runs.filter((x: any) => x.tier === 'audio')).toHaveLength(3);
  }, 60000);

  it('audio tier on a case with no expected state => 409, nothing started', async () => {
    const { w, base, H } = await api();
    const rt = await w.start('demo');
    await rt.sendPcm(tone(100)); w.stt.speechStarted(); w.stt.final('Three burgers.', 0); await wait(60);
    call(w.agent, 'z1', { item_id: 'burger', quantity: 2, modifiers: [] }); await w.agent.result('z1');
    await rt.end();
    const open = w.store.listCases({ session_id: rt.session_id })[0]!.id;
    const r = await fetch(`${base}/api/cases/${open}/replay?tier=audio`, { method: 'POST', headers: H });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: 'no_expected_state' });
  }, 30000);
});
