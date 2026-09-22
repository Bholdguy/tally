// Steps 11/12/15 server surface: the dashboard's static files (strict CSP), metrics, stored sessions, case audio, the demo runner, the SSE
// backlog, and the agent's audible reply going back to the browser over the mic socket.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { Secret } from '@tally/agent';
import { initDatabase } from '@tally/db';
import { Store } from '@tally/reliability';
import { buildApp } from '../src/app.js';
import { ensureBaseline } from '../src/bootstrap.js';
import { pcmToWav, SECURITY_HEADERS } from '../src/routes-extra.js';
import { SessionRuntime } from '../src/runtime.js';
import { mockAgent, mockStt, tone, wait, until } from './mocks.js';

const TOKEN = ['operator', 'token', '0123456789'].join('-');
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function world() {
  const agent = await mockAgent(); const stt = await mockStt();
  const dir = mkdtempSync(join(tmpdir(), 'tally-dash-'));
  initDatabase(join(dir, 't.sqlite'));
  const store = new Store(join(dir, 't.sqlite'));
  ensureBaseline(store, {});
  const dist = join(dir, 'dist'); mkdirSync(dist);
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>t</title>'); writeFileSync(join(dist, 'app.js'), 'console.log(1)'); writeFileSync(join(dist, 'style.css'), 'body{}');
  const { app, runtimes } = await buildApp({
    operatorToken: TOKEN, cases: store, dashboardDir: dist, allowedOrigin: 'http://localhost:5173',
    demo: { audioDir: join(dir, 'demo-audio'), runtime: () => ({}) },
    startRuntime: () => SessionRuntime.start({ agentConfig: { apiKey: new Secret('k-0000000'), wsUrl: agent.url, restUrl: 'http://x' }, store, audioDir: join(dir, 'audio'), mode: 'live', stt: { url: stt.url } }),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as any).port as number;
  cleanups.push(async () => { await app.close(); store.close(); await agent.close(); await stt.close(); });
  const H = { 'x-tally-operator': TOKEN, 'content-type': 'application/json' };
  return { app, runtimes, agent, stt, store, dir, port, base: `http://127.0.0.1:${port}`, H };
}

describe('static dashboard', () => {
  it('is served without a token (it contains no secrets) under a strict CSP; a missing build says how to build it', async () => {
    const w = await world();
    const r = await fetch(`${w.base}/`);
    expect(r.status).toBe(200);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(r.headers.get(k)).toBe(v);
    expect(r.headers.get('content-security-policy')).toMatch(/default-src 'none'.*script-src 'self'.*frame-ancestors 'none'/);
    expect(r.headers.get('content-security-policy')).not.toMatch(/unsafe-inline|unsafe-eval|assemblyai/);
    expect((await fetch(`${w.base}/app.js`)).headers.get('content-type')).toMatch(/javascript/);
    expect((await fetch(`${w.base}/style.css`)).headers.get('content-type')).toMatch(/css/);
    const { app } = await buildApp({ operatorToken: TOKEN, dashboardDir: join(w.dir, 'nope'), startRuntime: async () => { throw new Error('x'); } });
    expect((await app.inject({ url: '/' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/' })).json()).toMatchObject({ hint: expect.stringContaining('build:dashboard') });
    await app.close();
  });
  it('these read routes, and triggering a demo scenario, are open to a guest (no token, D-39); an unknown id is a plain 404', async () => {
    const w = await world();
    for (const p of ['/api/metrics', '/api/sessions', '/api/demo/scenarios']) expect((await fetch(w.base + p)).status, p).toBe(200);
    for (const p of ['/api/sessions/x/events', '/api/cases/x/audio']) expect((await fetch(w.base + p)).status, p).toBe(404);
    expect((await fetch(`${w.base}/api/demo/dropout`, { method: 'POST' })).status).toBe(202); // a guest CAN trigger a demo scenario playback
  });
});

describe('metrics and stored sessions', () => {
  it('GET /api/metrics returns the computed metrics; sessions and their stored events are listed (no raw wire payload)', async () => {
    const w = await world();
    const m = await (await fetch(`${w.base}/api/metrics`, { headers: w.H })).json() as any;
    expect(m).toMatchObject({ generated_from: 'stored rows', latency_basis: 'client-observed' });
    const s = await (await fetch(`${w.base}/api/sessions`, { headers: w.H })).json() as any;
    expect(s.sessions).toEqual([]);
    const created = await (await fetch(`${w.base}/api/sessions`, { method: 'POST', headers: w.H, body: '{}' })).json() as any;
    await wait(50);
    const list = await (await fetch(`${w.base}/api/sessions`, { headers: w.H })).json() as any;
    expect(list.sessions[0]).toMatchObject({ id: created.session_id, mode: 'live' });
    expect(list.active).toContain(created.session_id);
    const ev = await (await fetch(`${w.base}/api/sessions/${created.session_id}/events`, { headers: w.H })).json() as any;
    expect(ev.events.some((e: any) => e.kind === 'session_started')).toBe(true);
    expect(ev.events.every((e: any) => e.raw === undefined)).toBe(true);
    expect((await fetch(`${w.base}/api/sessions/nope/events`, { headers: w.H })).status).toBe(404);
  });
});

describe('SSE backlog and the agent audio going back to the browser', () => {
  it('a dashboard that attaches late still receives the whole call (stored events first, then live), without duplicates', async () => {
    const w = await world();
    const { session_id } = await (await fetch(`${w.base}/api/sessions`, { method: 'POST', headers: w.H, body: '{}' })).json() as any;
    await wait(50);
    const res = await fetch(`${w.base}/api/live/${session_id}`, { headers: w.H });
    const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = '';
    const got: any[] = [];
    const pump = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return; buf += dec.decode(value); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const f = buf.slice(0, i); buf = buf.slice(i + 2); const l = f.split('\n').find((x) => x.startsWith('data: ')); if (l) got.push(JSON.parse(l.slice(6))); } } })();
    await until(() => got.some((e) => e.kind === 'session_started') && got.some((e) => e.kind === 'order'), 3000, 'backlog');
    const ids = got.map((e) => e.id); expect(new Set(ids).size).toBe(ids.length);
    reader.cancel(); await pump.catch(() => undefined);
  });

  it('the agent\'s audible reply reaches the authenticated mic socket as binary PCM frames', async () => {
    const w = await world();
    const { session_id } = await (await fetch(`${w.base}/api/sessions`, { method: 'POST', headers: w.H, body: '{}' })).json() as any;
    const ws = new WebSocket(`ws://127.0.0.1:${w.port}/ws/mic`);
    const frames: Buffer[] = [];
    await new Promise<void>((res, rej) => { ws.on('open', () => ws.send(JSON.stringify({ session: session_id, token: TOKEN }))); ws.on('message', (d, bin) => { if (bin) frames.push(d as Buffer); else if (JSON.parse(d.toString()).type === 'ready') res(); }); ws.on('error', rej); });
    w.agent.push({ type: 'reply.audio', data: Buffer.from(tone(20, 6000)).toString('base64') });
    await until(() => frames.length === 1, 2000, 'agent audio frame');
    expect(frames[0]!.byteLength).toBe(960);
    ws.close();
  });
});

describe('case recording', () => {
  it('serves a playable WAV by case id (never a path), and 404 for a missing recording', async () => {
    const w = await world();
    w.store.createSession({ id: 's1', mode: 'demo', config_version: 'v1' }); w.store.openOrder('s1');
    const pcm = join(w.dir, 's1.pcm'); writeFileSync(pcm, Buffer.from(tone(100)));
    w.store.setAudioPointer('s1', pcm);
    w.store.insertEventRaw({ id: 'e1', session_id: 's1', direction: 'in', type: 'x', payload: { kind: 'x' }, t_ms: 1 });
    w.store.recordHold({ session_id: 's1', aai_call_id: 'c1', tool: 'add_item', args: {}, execution_mode: 'hold', status: 'conflict', code: 'QTY_MISMATCH', detail: 'd', evidence: {}, validation_event_id: 'v1', case: { pattern_key: 'p', threshold: 3, audio_exists: true, up_to_ms: 5 } });
    const id = w.store.listCases()[0]!.id;
    const r = await fetch(`${w.base}/api/cases/${id}/audio`, { headers: w.H });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('audio/wav');
    const b = Buffer.from(await r.arrayBuffer());
    expect(b.subarray(0, 4).toString()).toBe('RIFF');
    expect(b.byteLength).toBe(44 + 4800);
    expect((await fetch(`${w.base}/api/cases/nope/audio`, { headers: w.H })).status).toBe(404);
    expect(pcmToWav(new Uint8Array(0)).byteLength).toBe(44);
  });
});

describe('deterministic demo over HTTP', () => {
  it('POST /api/demo/dropout runs the scenario in the background, registers its session for the live stream, and reports the result; one run at a time; unknown names rejected', async () => {
    const w = await world();
    expect((await fetch(`${w.base}/api/demo/nope`, { method: 'POST', headers: w.H })).status).toBe(400);
    const list = await (await fetch(`${w.base}/api/demo/scenarios`, { headers: w.H })).json() as any;
    expect(list.scenarios.map((s: any) => s.name)).toEqual(['A', 'B', 'C', 'D', 'confidence', 'dropout']);
    expect(list.banner).toMatch(/scripted \(not the live agent\)/);
    const r = await fetch(`${w.base}/api/demo/dropout`, { method: 'POST', headers: w.H });
    expect(r.status).toBe(202);
    const { run_id } = await r.json() as any;
    expect((await fetch(`${w.base}/api/demo/confidence`, { method: 'POST', headers: w.H })).status).toBe(409);
    let run: any;
    for (let i = 0; i < 200; i++) { run = await (await fetch(`${w.base}/api/demo/runs/${run_id}`, { headers: w.H })).json(); if (run.status !== 'running') break; await wait(100); }
    expect(run.status).toBe('done');
    expect(run.sessions).toHaveLength(1);
    expect(w.runtimes.has(run.sessions[0])).toBe(true);
    expect(run.results[0].sessions[0].verdicts[0]).toMatchObject({ verdict: 'HOLD', code: 'UNVALIDATABLE' });
    const events = await (await fetch(`${w.base}/api/sessions/${run.sessions[0]}/events`, { headers: w.H })).json() as any;
    expect(events.events.filter((e: any) => e.kind === 'verdict')).toHaveLength(1);
    expect(events.events.some((e: any) => e.kind === 'evidence_stream_status' && e.status === 'down')).toBe(true);
  }, 60000);
});
