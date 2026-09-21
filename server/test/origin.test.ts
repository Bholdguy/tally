// The mic WebSocket's Origin policy. This file exists because the earlier tests connected WITHOUT an Origin header, and so missed that the
// server's default rejected the dashboard's own page (a browser always sends Origin). Every test here sends one, the way a browser does.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { Secret } from '@tally/agent';
import { initDatabase } from '@tally/db';
import { Store } from '@tally/reliability';
import { buildApp, originAllowed } from '../src/app.js';
import { startServer } from '../src/main.js';
import { SessionRuntime } from '../src/runtime.js';
import { mockAgent, mockStt, tone, until } from './mocks.js';

const TOKEN = ['operator', 'token', '0123456789'].join('-');
const KEY = ['k', 'origin', 'test', 'key', '0000000'].join('-');
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

describe('originAllowed (pure)', () => {
  it('accepts the page\'s own origin (host match, any scheme/port as sent), no Origin, and one extra exact origin; refuses everything else', () => {
    const host = '127.0.0.1:8787';
    expect(originAllowed(`http://${host}`, host)).toBe(true);
    expect(originAllowed(`https://${host}`, host)).toBe(true);                       // TLS terminated in front: same host
    expect(originAllowed('http://LOCALHOST:8787', 'localhost:8787')).toBe(true);       // case-insensitive
    expect(originAllowed(undefined, host)).toBe(true);                                // a non-browser client (still needs the token)
    expect(originAllowed('https://dash.example.com', host, 'https://dash.example.com')).toBe(true);   // the one configured extra
    for (const bad of ['http://evil.example', 'http://127.0.0.1:9999', 'http://localhost:8787', 'null', '', 'not a url', 'http://127.0.0.1:8787.evil.example', 'http://evil.example/127.0.0.1:8787', 'javascript:alert(1)', 'https://dash.example.com.evil.io'])
      expect(originAllowed(bad, host, 'https://dash.example.com'), bad).toBe(false);
    expect(originAllowed('http://127.0.0.1:8787', undefined)).toBe(false);            // no Host header to compare against
  });
});

const upgrade = (port: number, origin?: string) => new Promise<string>((res) => {
  const w = new WebSocket(`ws://127.0.0.1:${port}/ws/mic`, origin === undefined ? {} : { origin });
  w.on('open', () => { res('OPEN'); w.close(); });
  w.on('unexpected-response', (_q, r) => res(`REFUSED ${r.statusCode}`));
  w.on('error', () => res('ERROR'));
});

describe('the real server with its DEFAULT configuration, as a browser opens it', () => {
  it('startServer with no DASHBOARD_ORIGIN: the dashboard\'s own origin is accepted; a foreign origin, `null` and a look-alike are refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-origin-'));
    const srv = await startServer({ ASSEMBLYAI_API_KEY: KEY, TALLY_OPERATOR_TOKEN: TOKEN, PORT: '0', TALLY_DB_PATH: join(dir, 't.sqlite'), TALLY_AUDIO_DIR: join(dir, 'a') } as NodeJS.ProcessEnv);
    cleanups.push(() => srv.close());
    const port = (srv.app.server.address() as { port: number }).port;
    expect(srv.cfg.origin).toBeUndefined();                                            // nothing to configure
    expect(await upgrade(port, `http://127.0.0.1:${port}`)).toBe('OPEN');              // THE regression: this was 403
    expect(await upgrade(port, undefined)).toBe('OPEN');
    for (const bad of ['https://evil.example', 'null', `http://localhost:${port}`, `http://127.0.0.1:${port}.evil.example`]) expect(await upgrade(port, bad), bad).toBe('REFUSED 403');
  });

  it('DASHBOARD_ORIGIN adds exactly one extra origin and does not replace same-origin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-origin-'));
    const srv = await startServer({ ASSEMBLYAI_API_KEY: KEY, TALLY_OPERATOR_TOKEN: TOKEN, PORT: '0', TALLY_DB_PATH: join(dir, 't.sqlite'), TALLY_AUDIO_DIR: join(dir, 'a'), DASHBOARD_ORIGIN: 'https://dash.example.com' } as NodeJS.ProcessEnv);
    cleanups.push(() => srv.close());
    const port = (srv.app.server.address() as { port: number }).port;
    expect(await upgrade(port, 'https://dash.example.com')).toBe('OPEN');
    expect(await upgrade(port, `http://127.0.0.1:${port}`)).toBe('OPEN');
    expect(await upgrade(port, 'https://other.example.com')).toBe('REFUSED 403');
  });
});

describe('the full mic flow WITH an Origin header, as the dashboard does it', () => {
  it('same-origin browser: upgrade, first-frame token auth, audio in, and the agent\'s reply audio back; a foreign page never gets that far', async () => {
    const agent = await mockAgent(); const stt = await mockStt();
    const dir = mkdtempSync(join(tmpdir(), 'tally-origin-'));
    initDatabase(join(dir, 't.sqlite'));
    const store = new Store(join(dir, 't.sqlite'));
    const { app } = await buildApp({
      operatorToken: TOKEN, cases: store,
      startRuntime: () => SessionRuntime.start({ agentConfig: { apiKey: new Secret(KEY), wsUrl: agent.url, restUrl: 'http://x' }, store, audioDir: join(dir, 'audio'), mode: 'live', stt: { url: stt.url } }),
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as { port: number }).port;
    cleanups.push(async () => { await app.close(); store.close(); await agent.close(); await stt.close(); });
    const { session_id } = await (await fetch(`http://127.0.0.1:${port}/api/sessions`, { method: 'POST', headers: { 'x-tally-operator': TOKEN, 'content-type': 'application/json' }, body: '{}' })).json() as { session_id: string };

    const origin = `http://127.0.0.1:${port}`;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/mic`, { origin });
    const frames: Buffer[] = [];
    await new Promise<void>((res, rej) => { ws.on('open', () => ws.send(JSON.stringify({ session: session_id, token: TOKEN }))); ws.on('message', (d, bin) => { if (bin) frames.push(d as Buffer); else if (JSON.parse(d.toString()).type === 'ready') res(); }); ws.on('error', rej); });
    ws.send(tone(20));
    agent.push({ type: 'reply.audio', data: Buffer.from(tone(20, 6000)).toString('base64') });
    await until(() => frames.length === 1 && agent.audioBytes() >= 960, 3000, 'audio both ways');
    ws.close();

    expect(await upgrade(port, 'https://evil.example')).toBe('REFUSED 403');
  });
});
