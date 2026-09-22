// D-39: two dashboard access tiers. GUEST (no credential) can read everything and trigger a demo scenario; OPERATOR (session-cookie
// login, or the `x-tally-operator` header) unlocks every mutating route. Gated server-side on every route, never only by a hidden button.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initDatabase } from '@tally/db';
import { Store } from '@tally/reliability';
import { buildApp, type AppOptions } from '../src/app.js';

const TOKEN = ['operator', 'token', '0123456789'].join('-');
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

function mkCase(store: Store, sessionId: string, mode: 'live' | 'demo', callId: string, audioPointer: string) {
  store.createSession({ id: sessionId, mode, config_version: 'v1' });
  store.openOrder(sessionId);
  store.setAudioPointer(sessionId, audioPointer);
  store.insertEventRaw({ id: `e_${callId}`, session_id: sessionId, direction: 'in', type: 'evidence_transcript', payload: { kind: 'evidence_transcript', text: 'three burgers' }, t_ms: 1 });
  store.recordHold({
    session_id: sessionId, aai_call_id: callId, tool: 'add_item', args: { item_id: 'burger', quantity: 2 }, execution_mode: 'hold', status: 'conflict', code: 'QTY_MISMATCH', detail: 'd', evidence: {}, validation_event_id: `v_${callId}`,
    repair: { scope: 'burger', attempt: 1, prompt: 'p', outcome: 'pending' }, case: { pattern_key: 'QTY_MISMATCH|add_item|plain_statement|na', threshold: 3, audio_exists: true, up_to_ms: 10 },
  });
}

async function world(over: Partial<AppOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tally-tiers-'));
  initDatabase(join(dir, 't.sqlite'));
  const store = new Store(join(dir, 't.sqlite'));
  const pcm = join(dir, 's1.pcm'); writeFileSync(pcm, Buffer.alloc(4800));
  mkCase(store, 's1', 'demo', 'c1', pcm);
  // a case from a LIVE call (e.g. the pending human-mic validation): real audio/transcript, must stay operator-only (D-39)
  mkCase(store, 's-live', 'live', 'c2', pcm);
  const caseId = store.listCases().find((c) => c.session_id === 's1')!.id;
  const liveCaseId = store.listCases().find((c) => c.session_id === 's-live')!.id;
  const dist = join(dir, 'dist');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dist);
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>t</title>'); writeFileSync(join(dist, 'app.js'), 'console.log(1)'); writeFileSync(join(dist, 'style.css'), 'body{}');
  const { app } = await buildApp({
    operatorToken: TOKEN, cases: store, dashboardDir: dist, demo: { audioDir: join(dir, 'demo-audio'), runtime: () => ({}) },
    startRuntime: async () => { throw new Error('not exercised in this test'); },
    ...over,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  cleanups.push(async () => { await app.close(); store.close(); });
  return { base, caseId, liveCaseId, H: { 'x-tally-operator': TOKEN, 'content-type': 'application/json' } };
}

/** grabs just the session cookie's own attribute from a Set-Cookie line, for use as a Cookie header in the next request */
const cookieFrom = (res: Response): string => (res.headers.get('set-cookie') ?? '').split(';')[0]!;

describe('guest tier: no credential needed', () => {
  it('views the dashboard shell, sessions, cases, case detail, metrics, order/call-log data (session events) — all without any credential', async () => {
    const { base, caseId } = await world();
    for (const p of ['/', '/api/sessions', '/api/sessions/s1/events', '/api/cases', `/api/cases/${caseId}`, '/api/regressions/count', '/api/metrics', '/api/demo/scenarios']) {
      const r = await fetch(base + p);
      expect(r.status, p).toBeLessThan(400);
    }
    const cases = await (await fetch(`${base}/api/cases`)).json() as { cases: unknown[] };
    expect(cases.cases.length).toBe(1);
    const events = await (await fetch(`${base}/api/sessions/s1/events`)).json() as { order: unknown };
    expect(events).toHaveProperty('order'); // the order panel's data, readable by a guest
    expect(await (await fetch(`${base}/api/whoami`)).json()).toEqual({ role: 'guest' });
  });

  it('can trigger a demo scenario playback with no credential (the one write a guest is allowed)', async () => {
    const { base } = await world();
    const r = await fetch(`${base}/api/demo/dropout`, { method: 'POST' });
    expect(r.status).toBe(202);
    const { run_id } = await r.json() as { run_id: string };
    expect(run_id).toBeTruthy();
  });

  it('every mutating route refuses a guest with 403, whether the credential is absent or simply wrong — never a silent no-op, never 401', async () => {
    const { base, caseId } = await world();
    const mutating: [string, string][] = [
      ['POST', '/api/sessions'], ['POST', '/api/sessions/s1/end'], [`POST`, `/api/cases/${caseId}/accept`],
      ['POST', `/api/cases/${caseId}/replay?tier=evidence`], ['POST', '/api/configs'], ['POST', '/api/suite/run'],
      ['POST', '/api/configs/v1/promote'], ['POST', '/api/configs/rollback'],
    ];
    for (const [method, path] of mutating) {
      const noCred = await fetch(base + path, { method, headers: { 'content-type': 'application/json' } });
      expect(noCred.status, `${method} ${path} (no credential)`).toBe(403);
      expect(await noCred.json()).toMatchObject({ error: 'forbidden' });
      const wrong = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-tally-operator': 'wrong-token-wrong-token' } });
      expect(wrong.status, `${method} ${path} (wrong token)`).toBe(403);
    }
    // the database was not touched by any of the above
    expect((await (await fetch(`${base}/api/cases`)).json()).cases).toHaveLength(1);
  });
});

describe('operator tier: session-cookie login', () => {
  it('a correct token logs in and sets a session cookie; a wrong one is refused and sets none', async () => {
    const { base } = await world();
    const bad = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'nope' }) });
    expect(bad.status).toBe(401);
    expect(bad.headers.get('set-cookie')).toBeNull();
    const ok = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, role: 'operator' });
    const cookie = ok.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^tally_session=[0-9a-f]{48}/);
    expect(cookie).toMatch(/HttpOnly/); expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).not.toContain(TOKEN); // the cookie's own value is a random session id, never the operator token
  });

  it('the session cookie alone (no header) unlocks every mutating route, and GET /api/session reports operator', async () => {
    const { base, caseId } = await world();
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
    const Cookie = cookieFrom(login);
    expect(await (await fetch(`${base}/api/whoami`, { headers: { Cookie } })).json()).toEqual({ role: 'operator' });
    const start = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { Cookie, 'content-type': 'application/json' }, body: '{"mode":"demo"}' });
    expect(start.status, "operator gate must pass through to the runtime layer, not 403").not.toBe(403);
    const accept = await fetch(`${base}/api/cases/${caseId}/accept`, { method: 'POST', headers: { Cookie } });
    expect(accept.status).not.toBe(403);
    const config = await fetch(`${base}/api/configs`, { method: 'POST', headers: { Cookie, 'content-type': 'application/json' }, body: JSON.stringify({ version: 'v9', prompt_text: 'x', gating_params: {} }) });
    expect(config.status, 'operator gate must pass (whatever config validation then does is not this test\'s concern)').not.toBe(403);
  });

  it('logout clears the session: the same cookie is refused afterwards and the route reports guest again', async () => {
    const { base } = await world();
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
    const Cookie = cookieFrom(login);
    expect((await fetch(`${base}/api/sessions`, { method: 'POST', headers: { Cookie, 'content-type': 'application/json' }, body: '{}' })).status, "operator gate must pass").not.toBe(403);
    const out = await fetch(`${base}/api/logout`, { method: 'POST', headers: { Cookie } });
    expect(out.status).toBe(200);
    expect(await out.json()).toEqual({ ok: true, role: 'guest' });
    expect(out.headers.get('set-cookie')).toMatch(/Max-Age=0/);
    expect(await (await fetch(`${base}/api/whoami`, { headers: { Cookie } })).json()).toEqual({ role: 'guest' });
    expect((await fetch(`${base}/api/sessions`, { method: 'POST', headers: { Cookie, 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
  });

  it('a made-up cookie value is not a session: guest tier', async () => {
    const { base } = await world();
    expect(await (await fetch(`${base}/api/whoami`, { headers: { Cookie: 'tally_session=' + 'a'.repeat(48) } })).json()).toEqual({ role: 'guest' });
  });
});

describe('a LIVE-origin session/case stays operator-only even though guest reads are open (D-39)', () => {
  it('a guest cannot list, read, or hear a case from a live-mode session; an unknown scenario answer question: does not exist, matching a real 404', async () => {
    const { base, liveCaseId, H } = await world();
    const list = await (await fetch(`${base}/api/cases`)).json() as { cases: { id: string }[] };
    expect(list.cases.some((c) => c.id === liveCaseId), 'a live-origin case must not appear in the guest-visible list').toBe(false);
    expect((await fetch(`${base}/api/cases/${liveCaseId}`)).status).toBe(404);
    expect((await fetch(`${base}/api/cases/${liveCaseId}/audio`)).status).toBe(404);
    expect((await fetch(`${base}/api/cases/${liveCaseId}/replays`)).status).toBe(404);
    // the operator (header) sees it fine: this is a tier restriction, not a bug
    expect((await fetch(`${base}/api/cases/${liveCaseId}`, { headers: H })).status).toBe(200);
    expect((await fetch(`${base}/api/cases/${liveCaseId}/audio`, { headers: H })).status).toBe(200);
  });

  it("a guest cannot list a live session, read its events, or attach to its live SSE stream; a demo session is unaffected", async () => {
    const { base, H } = await world();
    const sessions = await (await fetch(`${base}/api/sessions`)).json() as { sessions: { id: string }[] };
    expect(sessions.sessions.map((s) => s.id)).toEqual(['s1']); // the live session is not even listed for a guest
    expect((await fetch(`${base}/api/sessions/s-live/events`)).status).toBe(404);
    expect((await fetch(`${base}/api/sessions/s1/events`)).status).toBe(200); // the demo session is unaffected
    // operator sees both
    const opSessions = await (await fetch(`${base}/api/sessions`, { headers: H })).json() as { sessions: { id: string }[] };
    expect(opSessions.sessions.map((s) => s.id).sort()).toEqual(['s-live', 's1']);
    expect((await fetch(`${base}/api/sessions/s-live/events`, { headers: H })).status).toBe(200);
  });
});

describe('the guest-triggerable demo route has its own abuse guards (D-39)', () => {
  it('is bounded to exactly the six defined scenario names (plus the "all" alias); anything else is 400, not run', async () => {
    const { base } = await world();
    for (const bad of ['nope', 'A;DROP TABLE cases', '../../etc/passwd', '', 'ALL', 'confidence ']) {
      const r = await fetch(`${base}/api/demo/${encodeURIComponent(bad)}`, { method: 'POST' });
      expect(r.status, bad).toBe(400);
    }
  });

  it('a guest hammering the route faster than it can genuinely run is refused (429), not queued or spammed', async () => {
    const { base } = await world({ demoMinIntervalMs: 60000 });
    const first = await fetch(`${base}/api/demo/dropout`, { method: 'POST' });
    expect(first.status).toBe(202);
    const { run_id } = await first.json() as { run_id: string };
    // wait for the FIRST run to actually finish, so the next request exercises the cooldown, not just the overlap lock
    let done = false;
    for (let i = 0; i < 100 && !done; i++) {
      const j = await (await fetch(`${base}/api/demo/runs/${run_id}`)).json() as { status: string };
      done = j.status !== 'running';
      if (!done) await new Promise((r) => setTimeout(r, 200));
    }
    expect(done, 'the dropout scenario must finish within the poll window').toBe(true);
    // immediately re-trigger: the overlap lock no longer applies (the prior run is done), so this must be the COOLDOWN refusing it
    const second = await fetch(`${base}/api/demo/confidence`, { method: 'POST' });
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ error: 'demo_rate_limited' });
  }, 20000);
});
