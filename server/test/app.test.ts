import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { Secret } from '@tally/agent';
import { initDatabase } from '@tally/db';
import { Store } from '@tally/reliability';
import { assertSafeConfig, startServer } from '../src/main.js';
import { buildApp, tokenMatches } from '../src/app.js';
import { SessionRuntime } from '../src/runtime.js';
import { mockAgent, mockStt, tone, until, wait } from './mocks.js';

// built at runtime so this file never contains a key-shaped literal (the secret scanner stays strict)
const TOKEN = ['operator', 'token', '0123456789'].join('-');
const KEY = ['k', 'secret', 'api', 'key', '0000000'].join('-');
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function server(over: Partial<Parameters<typeof buildApp>[0]> = {}) {
  const agent = await mockAgent(); const stt = await mockStt();
  const dir = mkdtempSync(join(tmpdir(), 'tally-app-'));
  initDatabase(join(dir, 't.sqlite'));
  const store = new Store(join(dir, 't.sqlite'));
  const { app, runtimes } = await buildApp({
    operatorToken: TOKEN, allowedOrigin: 'http://localhost:5173', authTimeoutMs: 400,
    startRuntime: ({ mode }) => SessionRuntime.start({ agentConfig: { apiKey: new Secret(KEY), wsUrl: agent.url, restUrl: 'http://x' }, store, audioDir: join(dir, 'audio'), mode: mode ?? 'demo', stt: { url: stt.url } }),
    ...over,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as any).port as number;
  cleanups.push(async () => { await app.close(); store.close(); await agent.close(); await stt.close(); });
  const H = { 'x-tally-operator': TOKEN, 'content-type': 'application/json' };
  return { app, runtimes, agent, stt, store, port, base: `http://127.0.0.1:${port}`, H };
}

const openWs = (port: number, opts: { origin?: string } = {}) => new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}/ws/mic`, { origin: opts.origin }); w.once('open', () => res(w)); w.once('error', rej); });
const closeInfo = (w: WebSocket) => new Promise<{ code: number; reason: string }>((r) => w.once('close', (code, reason) => r({ code, reason: reason.toString() })));

describe('token comparison', () => {
  it('is exact, constant-time, and rejects non-strings / empty', () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(TOKEN + 'x', TOKEN)).toBe(false);
    expect(tokenMatches(undefined, TOKEN)).toBe(false);
    expect(tokenMatches('', TOKEN)).toBe(false);
    expect(tokenMatches(['a'] as unknown, TOKEN)).toBe(false);
  });
});

describe('HTTP API: authentication and hygiene', () => {
  it('healthz and read routes are open to guests (no credential); mutating routes refuse a guest with 403, never 401 (D-39)', async () => {
    const s = await server();
    expect((await fetch(`${s.base}/healthz`)).status).toBe(200);
    // guest reads: an unknown id is a plain 404, never an auth error
    for (const [method, path] of [['GET', '/api/sessions/x'], ['GET', '/api/live/x']] as const) {
      expect((await fetch(`${s.base}${path}`, { method })).status, `${method} ${path} as guest`).toBe(404);
    }
    // guest writes: refused, with or without a (wrong) credential
    for (const [method, path] of [['POST', '/api/sessions'], ['POST', '/api/sessions/x/end']] as const) {
      expect((await fetch(`${s.base}${path}`, { method })).status, `${method} ${path} without credential`).toBe(403);
      expect((await fetch(`${s.base}${path}`, { method, headers: { 'x-tally-operator': 'wrong-token-wrong-token' } })).status, `${method} ${path} wrong token`).toBe(403);
    }
  });

  it('a token in the URL is NOT accepted for a mutating route (it would leak into logs)', async () => {
    const s = await server();
    expect((await fetch(`${s.base}/api/sessions/x/end?token=${TOKEN}`, { method: 'POST' })).status).toBe(403);
  });

  it('start, inspect and end a session; responses never contain the operator token or the AssemblyAI key', async () => {
    const s = await server();
    const started = await fetch(`${s.base}/api/sessions`, { method: 'POST', headers: s.H, body: JSON.stringify({ mode: 'demo' }) });
    expect(started.status).toBe(201);
    const { session_id } = await started.json() as { session_id: string };
    const state = await (await fetch(`${s.base}/api/sessions/${session_id}`, { headers: s.H })).text();
    expect(JSON.parse(state)).toMatchObject({ session_id, started: true, ended: false });
    const ended = await (await fetch(`${s.base}/api/sessions/${session_id}/end`, { method: 'POST', headers: s.H })).text();
    expect(JSON.parse(ended).audio.sha256).toMatch(/^[0-9a-f]{64}$/);
    for (const body of [state, ended]) { expect(body).not.toContain(TOKEN); expect(body).not.toContain(KEY); }
    expect((await fetch(`${s.base}/api/sessions/nope`, { headers: s.H })).status).toBe(404);
  });

  it('a session that cannot be validated is not started: 503 with a non-sensitive reason', async () => {
    const s = await server({ startRuntime: async () => { throw new Error('independent evidence stream could not connect'); } });
    const r = await fetch(`${s.base}/api/sessions`, { method: 'POST', headers: s.H, body: '{}' });
    expect(r.status).toBe(503);
    const text = await r.text();
    expect(JSON.parse(text)).toMatchObject({ error: 'session_not_started' });
    expect(text).not.toMatch(/at .*\.ts|node_modules|stack/i);
  });

  it('there is NO route that writes an order (rule 8): the API only starts/inspects/ends sessions and streams events', async () => {
    const s = await server();
    const routes = s.app.printRoutes({ commonPrefix: false });
    for (const r of ['healthz', 'sessions', 'live']) expect(routes).toContain(r);      // (the tree prints the shared prefix once)
    expect(routes).not.toMatch(/orders?\b/i);
    expect(routes).not.toMatch(/tool|commit|add_item|confirm/i);
  });
});

describe('SSE: live evidence stream', () => {
  it('streams typed events (independent transcripts, local speech) to an authorised client; the wire payload is not forwarded', async () => {
    const s = await server();
    const { session_id } = await (await fetch(`${s.base}/api/sessions`, { method: 'POST', headers: s.H, body: '{}' })).json() as { session_id: string };
    const res = await fetch(`${s.base}/api/live/${session_id}`, { headers: { 'x-tally-operator': TOKEN } });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const pump = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return; buf += dec.decode(value); } })();
    await wait(80);
    s.stt.final('Two burgers.', 0);
    s.agent.push({ type: 'input.speech.started' });
    await until(() => buf.includes('evidence_transcript') && buf.includes('input_speech_started'), 3000, 'SSE events');
    const lines = buf.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
    expect(lines.find((e) => e.kind === 'evidence_transcript')).toMatchObject({ text: 'Two burgers.', end_of_turn: true, session_id });
    expect(lines.every((e) => !('raw' in e))).toBe(true);
    expect(buf).not.toContain(KEY);
    await reader.cancel(); await pump.catch(() => undefined);
  });
});

describe('WebSocket mic bridge', () => {
  async function ready() {
    const s = await server();
    const { session_id } = await (await fetch(`${s.base}/api/sessions`, { method: 'POST', headers: s.H, body: '{}' })).json() as { session_id: string };
    return { ...s, session_id };
  }
  const auth = (w: WebSocket, session: string, token = TOKEN) => { w.send(JSON.stringify({ session, token })); return new Promise<any>((r) => w.once('message', (d) => r(JSON.parse(d.toString())))); };

  it('a wrong token is refused (close 1008) and nothing is sent to the agent', async () => {
    const s = await ready();
    const w = await openWs(s.port); const closed = closeInfo(w);
    w.send(JSON.stringify({ session: s.session_id, token: 'nope-nope-nope-nope-x' }));
    expect((await closed).code).toBe(1008);
    expect(s.agent.audioBytes()).toBe(0);
  });

  it('a binary first frame or an unknown session is refused', async () => {
    const s = await ready();
    const a = await openWs(s.port); const ca = closeInfo(a); a.send(Buffer.alloc(960)); expect((await ca).code).toBe(1008);
    const b = await openWs(s.port); const cb = closeInfo(b); b.send(JSON.stringify({ session: 'no-such', token: TOKEN })); expect((await cb).code).toBe(1008);
  });

  it('no authentication within the timeout => closed', async () => {
    const s = await ready();
    const w = await openWs(s.port);
    expect((await closeInfo(w)).code).toBe(1008);
  });

  it('an authenticated client streams PCM that reaches the agent, the recorder and the independent stream; only ONE mic per session', async () => {
    const s = await ready();
    const w = await openWs(s.port);
    expect(await auth(w, s.session_id)).toEqual({ type: 'ready' });
    for (let i = 0; i < 10; i++) { w.send(tone(20)); await wait(20); }        // 200 ms of speech at real time
    await until(() => s.agent.audioBytes() >= 9000, 3000, 'audio to agent');
    expect(s.runtimes.get(s.session_id)!.state().audio.bytes).toBeGreaterThanOrEqual(9000);
    const second = await openWs(s.port); const closed2 = closeInfo(second);
    second.send(JSON.stringify({ session: s.session_id, token: TOKEN }));
    expect((await closed2).code).toBe(1008);                                    // a second microphone cannot attach
    w.close();
  });

  it('an oversize frame is refused (1009); a client sending far faster than real time is disconnected (1013), not buffered forever', async () => {
    const s = await ready();
    const big = await openWs(s.port); await auth(big, s.session_id);
    const cb = closeInfo(big); big.send(Buffer.alloc(20000)); expect((await cb).code).toBe(1009);
    await wait(50);
    const fast = await openWs(s.port); await auth(fast, s.session_id);
    const cf = closeInfo(fast);
    for (let i = 0; i < 400; i++) fast.send(tone(20));                          // 8 s of audio in a burst: > the 5 s queue bound
    expect((await cf).code).toBe(1013);
  });

  it('a browser from another Origin is refused at the upgrade; other paths are refused', async () => {
    const s = await ready();
    await expect(openWs(s.port, { origin: 'http://evil.example' })).rejects.toThrow();
    const w = new WebSocket(`ws://127.0.0.1:${s.port}/other`);
    await expect(new Promise((res, rej) => { w.once('open', res); w.once('error', rej); })).rejects.toThrow();
  });
});

describe('startup safety: refuses to run unsafely', () => {
  const ok = { ASSEMBLYAI_API_KEY: KEY, TALLY_OPERATOR_TOKEN: TOKEN } as NodeJS.ProcessEnv;
  it('missing API key', () => expect(() => assertSafeConfig({ TALLY_OPERATOR_TOKEN: TOKEN } as NodeJS.ProcessEnv)).toThrow(/ASSEMBLYAI_API_KEY/));
  it('missing or short operator token', () => {
    expect(() => assertSafeConfig({ ASSEMBLYAI_API_KEY: KEY } as NodeJS.ProcessEnv)).toThrow(/TALLY_OPERATOR_TOKEN/);
    expect(() => assertSafeConfig({ ...ok, TALLY_OPERATOR_TOKEN: 'short' })).toThrow(/at least 16/);
  });
  it('non-loopback bind needs an explicit opt-in', () => {
    expect(() => assertSafeConfig({ ...ok, HOST: '0.0.0.0' })).toThrow(/not loopback/);
    expect(() => assertSafeConfig({ ...ok, HOST: '192.168.1.5' })).toThrow(/not loopback/);
    expect(assertSafeConfig({ ...ok, HOST: '0.0.0.0', TALLY_ALLOW_REMOTE: '1' }).host).toBe('0.0.0.0');
  });
  it('defaults are safe: loopback, same-origin only (no extra allowed origin), local data paths', () => {
    expect(assertSafeConfig(ok)).toMatchObject({ host: '127.0.0.1', port: 8787, origin: undefined });
  });
  it('startServer really listens on loopback with the API protected, and stops cleanly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-main-'));
    const srv = await startServer({ ...ok, PORT: '0', TALLY_DB_PATH: join(dir, 't.sqlite'), TALLY_AUDIO_DIR: join(dir, 'audio') } as NodeJS.ProcessEnv);
    const port = (srv.app.server.address() as any).port;
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/api/sessions`, { method: 'POST' })).status).toBe(403);
    await srv.close();
  });
});
