// END-TO-END through the real SessionRuntime: mock Voice Agent + mock streaming STT -> real recorder, local speech check,
// ingest (SQLite), evidence tracker, gate, committer -> tool.result back on the agent wire. Real clock, real files.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Secret } from '@tally/agent';
import { initDatabase } from '@tally/db';
import { Store } from '@tally/reliability';
import type { TallyEvent } from '@tally/contract';
import { SessionRuntime, type RuntimeOptions } from '../src/runtime.js';
import { mockAgent, mockStt, tone, until, wait, type MockAgent, type MockStt } from './mocks.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function rig(over: Partial<RuntimeOptions> = {}) {
  const agent = await mockAgent();
  const stt = await mockStt();
  const dir = mkdtempSync(join(tmpdir(), 'tally-rt-'));
  const dbPath = join(dir, 't.sqlite');
  initDatabase(dbPath);
  const store = new Store(dbPath);
  const events: TallyEvent[] = [];
  const rt = await SessionRuntime.start({
    agentConfig: { apiKey: new Secret('k-0000000'), wsUrl: agent.url, restUrl: 'http://x' }, store, audioDir: join(dir, 'audio'),
    mode: 'demo', stt: { url: stt.url }, onEvent: (e) => events.push(e), ...over,
  });
  cleanups.push(async () => { await rt.end().catch(() => undefined); store.close(); await agent.close(); await stt.close(); });
  return { rt, agent, stt, store, events, dir };
}
const q = (s: Store, sql: string, ...p: unknown[]) => s.r.prepare(sql).all(...p) as any[];
const call = (agent: MockAgent, id: string, name: string, args: unknown) => agent.push({ type: 'tool.call', call_id: id, name, arguments: args });

describe('composition root: end to end', () => {
  it('starts both streams, and the agent hears the same audio the recorder, the independent stream and the local check hear', async () => {
    const { rt, agent, stt } = await rig();
    await rt.sendPcm(tone(300));
    await until(() => stt.bytes() >= 13000 && agent.audioBytes() >= 14000, 3000, 'audio delivery');
    const end = await rt.end();
    expect(agent.audioBytes()).toBe(end.audio.bytes);                          // every byte sent to the agent was recorded, and vice versa
    expect(stt.bytes()).toBeLessThanOrEqual(end.audio.bytes);
    expect(end.audio.bytes - stt.bytes()).toBeLessThan(2400);                  // independent stream lags only by its sub-frame buffer (<50 ms)
    expect(end.audio.bytes).toBe(Math.round((300 * 24000) / 1000) * 2);
  });

  it('CLEAN ORDER: independent evidence + agent tool calls -> ALLOWED on the wire, order and total committed', async () => {
    const { rt, agent, stt, store } = await rig();
    stt.final('Two burgers and a coke.', 0);
    await wait(60);
    call(agent, 'c1', 'add_item', { item_id: 'burger', quantity: 2, modifiers: [] });
    expect(await agent.result('c1')).toMatchObject({ status: 'OK' });
    call(agent, 'c2', 'add_item', { item_id: 'coke', quantity: 1, modifiers: [] });
    expect(await agent.result('c2')).toMatchObject({ status: 'OK', total: '$20.47' });
    expect(store.getOrder(rt.session_id)!.state.lines).toEqual([{ item_id: 'burger', quantity: 2, modifiers: [] }, { item_id: 'coke', quantity: 1, modifiers: [] }]);
  });

  it('SCENARIO B end to end: stale call HELD (instruction on the wire, order untouched), corrected call ALLOWED, total 2697', async () => {
    const { rt, agent, stt, store } = await rig();
    stt.final('Two burgers, no wait, make it three.', 0);
    await wait(60);
    call(agent, 'b1', 'add_item', { item_id: 'burger', quantity: 2, modifiers: [] });
    const held = await agent.result('b1');
    expect(held).toMatchObject({ status: 'HELD', code: 'QTY_MISMATCH' });
    expect(held.instruction).toContain("Just to confirm, that's 3 classic burgers?");
    expect(store.getOrder(rt.session_id)!.state.lines).toEqual([]);
    expect(q(store, 'SELECT status,conflict_type FROM tool_calls WHERE session_id=?', rt.session_id)).toEqual([{ status: 'conflict', conflict_type: 'QTY_MISMATCH' }]);

    stt.final('Yes, three.', 1);
    await wait(60);
    call(agent, 'b2', 'add_item', { item_id: 'burger', quantity: 3, modifiers: [] });
    expect(await agent.result('b2')).toMatchObject({ status: 'OK', total: '$26.97' });
    expect(store.getOrder(rt.session_id)!.total_cents).toBe(2697);
  });

  it('REAL HALLUCINATION over the wire: a correct quantity with unrequested modifiers is HELD (content, not just quantity)', async () => {
    const { rt, agent, stt, store } = await rig();
    stt.final('2 burgers.', 0); stt.final('No, wait, make it 3.', 1);
    await wait(60);
    call(agent, 'h1', 'add_item', { item_id: 'burger', quantity: 3, modifiers: ['no_onions', 'no_pickles', 'no_tomato', 'no_lettuce', 'no_sauce'] });
    expect(await agent.result('h1')).toMatchObject({ status: 'HELD', code: 'REMOVAL_MISMATCH' });
    expect(store.getOrder(rt.session_id)!.state.lines).toEqual([]);
    call(agent, 'h2', 'add_item', { item_id: 'burger', quantity: 3, modifiers: [] });
    expect((await agent.result('h2')).status).toBe('OK');
  });

  it('LOCAL SPEECH CHECK drives the wait: the customer is still speaking when the tool call arrives, the gate waits for the independent final, then holds the stale call', async () => {
    const { rt, agent, stt, store } = await rig();
    stt.final('Two burgers.', 0);
    await wait(60);
    const audio = rt.sendPcm(tone(500)).then(() => rt.sendPcm(new Uint8Array(33600)));   // 500 ms of speech, then 700 ms of silence
    await wait(150);                                                                       // local check has flagged speech by now (~40 ms onset)
    expect(rt.state().evidence.speechInFlight).toBe(true);
    call(agent, 'w1', 'add_item', { item_id: 'burger', quantity: 2, modifiers: [] });       // the agent's stale call arrives mid-correction
    setTimeout(() => stt.speechStarted(), 250);                                            // independent stream acknowledges ~0.25 s after onset
    setTimeout(() => stt.final('Two burgers. No, wait, make it three.', 0), 1150);         // and finalises ~0.65 s after the speech ended
    const t0 = Date.now();
    const res = await agent.result('w1');
    const waited = Date.now() - t0;
    expect(res).toMatchObject({ status: 'HELD', code: 'QTY_MISMATCH' });
    expect(waited).toBeGreaterThan(800);                                                   // the gate visibly waited for independent evidence
    expect(waited).toBeLessThan(3000);
    expect(store.getOrder(rt.session_id)!.state.lines).toEqual([]);
    await audio;
  });

  it('DROPOUT end to end: the independent stream dies while a call is waiting -> HELD UNVALIDATABLE on the agent wire, promptly', async () => {
    const { rt, agent, stt, store } = await rig();
    stt.final('Two burgers.', 0);
    await wait(60);
    const audio = rt.sendPcm(tone(800));
    await wait(200);
    call(agent, 'd1', 'add_item', { item_id: 'burger', quantity: 2, modifiers: [] });
    setTimeout(() => stt.drop(), 250);
    const t0 = Date.now();
    const res = await agent.result('d1');
    expect(res).toMatchObject({ status: 'HELD', code: 'UNVALIDATABLE' });
    expect(Date.now() - t0).toBeLessThan(1500);                                            // nowhere near the 4 s timeout
    expect(store.getOrder(rt.session_id)!.state.lines).toEqual([]);
    await audio.catch(() => undefined);
  });

  it('refuses to START a call it cannot validate: independent stream unreachable => start() rejects, recorder closed, session ended', async () => {
    const agent = await mockAgent();
    const dir = mkdtempSync(join(tmpdir(), 'tally-rt-'));
    initDatabase(join(dir, 't.sqlite'));
    const store = new Store(join(dir, 't.sqlite'));
    cleanups.push(async () => { store.close(); await agent.close(); });
    await expect(SessionRuntime.start({
      agentConfig: { apiKey: new Secret('k-0000000'), wsUrl: agent.url, restUrl: 'http://x' }, store, audioDir: join(dir, 'audio'), sessionId: 'sess_fail', stt: { url: 'ws://127.0.0.1:1' },
    })).rejects.toThrow(/refusing to start a call Tally cannot validate/);
    expect(q(store, 'SELECT ended_at FROM sessions WHERE id=?', 'sess_fail')[0].ended_at).toBeGreaterThan(0);
    expect(agent.sockets).toHaveLength(0);                                                 // the agent session was never opened
  });

  it('PERSISTENCE: after the call every stream is in the database with provenance, the audio pointer resolves to the exact bytes sent, and ended_at is set', async () => {
    const { rt, agent, stt, store } = await rig();
    // agent-side events, including a genuine interruption over AUDIBLE agent speech (derived barge-in) and server timestamps
    agent.push({ type: 'transcript.user.delta', text: 'two', item_id: 'm1' });
    agent.push({ type: 'transcript.user', text: '2 burgers.', item_id: 'm1' });
    agent.push({ type: 'reply.started', reply_id: 'r1' });
    agent.push({ type: 'reply.audio', data: Buffer.from(tone(20, 6000)).toString('base64') });
    agent.push({ type: 'transcript.agent', text: 'Got it, two burgers.', reply_id: 'r1', interrupted: true });
    agent.push({ type: 'input.speech.started' });
    agent.push({ type: 'reply.done', status: 'interrupted', reply_id: 'r1' });
    stt.speechStarted(); stt.final('2 burgers. No, wait, make it 3.', 0, 0.71);
    await rt.sendPcm(tone(400));
    await until(() => q(store, "SELECT count(*) c FROM vad_events WHERE session_id=? AND type='barge_in'", rt.session_id)[0].c === 1, 3000, 'barge-in row');
    await wait(100);
    const end = await rt.end();

    const sid = rt.session_id;
    const sess = q(store, 'SELECT audio_pointer,ended_at,aai_session_id,mode FROM sessions WHERE id=?', sid)[0];
    expect(sess).toMatchObject({ aai_session_id: 'aai-mock', mode: 'demo' });
    expect(sess.ended_at).toBeGreaterThan(0);
    expect(sess.audio_pointer).toBe(end.audio.pointer);
    expect(statSync(sess.audio_pointer).size).toBe(end.audio.bytes);
    expect(createHash('sha256').update(readFileSync(sess.audio_pointer)).digest('hex')).toBe(end.audio.sha256);

    const utt = q(store, 'SELECT source,speaker,is_partial,text,confidence,server_ts_ms FROM utterances WHERE session_id=?', sid);
    expect(utt.some((u) => u.source === 'agent_stream' && u.speaker === 'user' && u.text === '2 burgers.')).toBe(true);
    expect(utt.some((u) => u.source === 'agent_stream' && u.speaker === 'agent' && u.text === 'Got it, two burgers.')).toBe(true);
    const indep = utt.find((u) => u.source === 'independent_stt' && u.is_partial === 0)!;
    expect(indep).toMatchObject({ text: '2 burgers. No, wait, make it 3.', confidence: 0.71 });
    expect(utt.filter((u) => u.source === 'agent_stream').every((u) => typeof u.server_ts_ms === 'number')).toBe(true);   // server timestamps kept

    const vad = q(store, 'SELECT source,type,derived FROM vad_events WHERE session_id=?', sid);
    expect(new Set(vad.map((v) => v.source))).toEqual(new Set(['agent', 'independent', 'local', 'derived']));
    expect(vad.filter((v) => v.type === 'barge_in')).toEqual([{ source: 'derived', type: 'barge_in', derived: 1 }]);

    const ents = q(store, "SELECT e.value,u.source FROM entities e JOIN utterances u ON u.id=e.source_utterance_id WHERE e.session_id=? AND e.type='quantity' AND e.superseded_by IS NULL", sid);
    expect(ents).toEqual([{ value: '3', source: 'independent_stt' }]);                        // current quantity evidence: 3, from the independent stream

    expect(q(store, 'SELECT count(*) c FROM events_raw WHERE session_id=?', sid)[0].c).toBe(end.ingest.events);
    expect(end.ingest.errors).toBe(0);
  });

  it('ONE TIMELINE: agent events, independent events and local speech events share the session clock (t_ms is comparable across sources)', async () => {
    const { rt, agent, stt, store } = await rig();
    stt.final('a coke', 0);
    agent.push({ type: 'input.speech.started' });
    await rt.sendPcm(tone(200));
    await wait(100);
    const now = performance.now();
    const rows = q(store, 'SELECT type,t_ms FROM events_raw WHERE session_id=? ORDER BY t_ms', rt.session_id);
    const kinds = new Set(rows.map((r) => r.type));
    expect(kinds.has('evidence_transcript') && kinds.has('input_speech_started') && kinds.has('local_vad')).toBe(true);
    const span = Math.max(...rows.map((r) => r.t_ms)) - Math.min(...rows.map((r) => r.t_ms));
    expect(span).toBeLessThan(1500);                                                        // a common origin: nothing is minutes apart or negative
    expect(Math.min(...rows.map((r) => r.t_ms))).toBeGreaterThanOrEqual(0);
    expect(now).toBeGreaterThan(0);
  });

  it('the agent is not given a DB handle: an order changes ONLY through the gate (a direct tool.call cannot bypass it)', async () => {
    const { rt, agent, store } = await rig();
    // no independent evidence at all: even a perfectly formed call must not commit
    call(agent, 'n1', 'add_item', { item_id: 'burger', quantity: 2, modifiers: [] });
    expect(await agent.result('n1')).toMatchObject({ status: 'HELD', code: 'UNVALIDATABLE' });
    expect(store.getOrder(rt.session_id)!.state.lines).toEqual([]);
  });
});

describe('Step 7 end to end: holds become stored cases through the real runtime', () => {
  it('SCENARIO B: the stale call becomes a case (real recording, stored evidence); case and repair events are emitted; resolution sets expected state; hangup marks leftovers pending', async () => {
    const { rt, agent, stt, store, events } = await rig();
    await rt.sendPcm(tone(200)); await rt.sendPcm(new Uint8Array(33600));   // real audio (the recording is non-empty; the local check hears speech, then silence)
    stt.speechStarted(); stt.final('Two burgers, no wait, make it three.', 0);   // ...and the independent stream acknowledges and finalises it
    await wait(60);
    call(agent, 'k1', 'add_item', { item_id: 'burger', quantity: 2, modifiers: [] });
    expect(await agent.result('k1')).toMatchObject({ status: 'HELD' });
    const cases = store.listCases({ session_id: rt.session_id });
    expect(cases).toHaveLength(1);
    const c = store.getCase(cases[0]!.id)!;
    expect(c).toMatchObject({ pattern_key: 'QTY_MISMATCH|add_item|correction|mid_item', resolution: 'open', tag: 'none', expected_state_json: null });
    expect(statSync(c.audio_pointer).size).toBeGreaterThan(0);
    const snap = JSON.parse(c.event_snapshot_json);
    expect(snap.events.some((e: { kind: string; text?: string }) => e.kind === 'evidence_transcript' && /make it three/.test(e.text ?? ''))).toBe(true);
    expect(events.filter((e) => e.kind === 'case')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'repair').map((e) => (e as { outcome: string }).outcome)).toEqual(['asked']);

    stt.final('Yes, three.', 1);
    await wait(60);
    call(agent, 'k2', 'add_item', { item_id: 'burger', quantity: 3, modifiers: [] });
    expect(await agent.result('k2')).toMatchObject({ status: 'OK' });
    expect(JSON.parse(store.getCase(c.id)!.expected_state_json!).state.lines).toEqual([{ item_id: 'burger', quantity: 3, modifiers: [] }]);
    expect(events.filter((e) => e.kind === 'repair').map((e) => (e as { outcome: string }).outcome)).toEqual(['asked', 'resolved']);

    stt.final('And two cokes.', 2);
    await wait(60);
    call(agent, 'k3', 'add_item', { item_id: 'coke', quantity: 1, modifiers: [] });
    expect(await agent.result('k3')).toMatchObject({ status: 'HELD' });
    await rt.end();
    const after = store.listCases({ session_id: rt.session_id }).map((x) => store.getCase(x.id)!.resolution).sort();
    expect(after).toEqual(['resolved', 'unresolved_at_hangup']);
  });
});
