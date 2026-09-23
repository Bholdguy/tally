// Protocol-conformance tests for the independent STT client against a mock that follows the DOCUMENTED streaming API
// (and the shapes actually observed in spike A). They prove OUR client's framing/auth/handling, not API behaviour.
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { SttStream } from '../src/stream.js';
import { fetchSessionTimeline } from '../src/timeline.js';

let wss: WebSocketServer;
let sockets: ServerSocket[] = [];
let req: { url?: string; auth?: string } = {};
const binary: Buffer[] = [];
const text: any[] = [];

async function start(): Promise<string> {
  wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.once('listening', r));
  wss.on('connection', (s, r) => {
    sockets.push(s);
    req = { url: r.url, auth: r.headers.authorization };
    s.on('message', (d, isBin) => { if (isBin) binary.push(d as Buffer); else { const m = JSON.parse(d.toString()); text.push(m); if (m.type === 'Terminate') s.send(JSON.stringify({ type: 'Termination', audio_duration_seconds: 1, session_duration_seconds: 1 })); } });
    s.send(JSON.stringify({ type: 'Begin', id: 'stt-1', expires_at: 1 }));
  });
  return `ws://127.0.0.1:${(wss.address() as any).port}`;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 2000) => { const t = Date.now(); while (!f() && Date.now() - t < ms) await wait(10); if (!f()) throw new Error('until timeout'); };
afterEach(async () => { for (const s of sockets) s.terminate(); sockets = []; binary.length = 0; text.length = 0; req = {}; await new Promise<void>((r) => wss.close(() => r())); });

const key = { reveal: () => 'stt-key-000000' };

describe('SttStream', () => {
  it('connects with the documented params, key in the Authorization header WITHOUT "Bearer", never in the URL', async () => {
    const url = await start();
    const s = new SttStream({ apiKey: key, url });
    await s.connect();
    expect(req.auth).toBe('stt-key-000000');
    expect(req.url).toContain('speech_model=universal-3-5-pro');
    expect(req.url).toContain('sample_rate=24000');
    expect(req.url).toContain('encoding=pcm_s16le');
    expect(decodeURIComponent(req.url!)).toContain('language_codes=["en"]'); // default steering: unsteered multilingual is what misread real speech as other languages
    expect(req.url).not.toContain('stt-key');
    expect(s.sessionId).toBe('stt-1');
    await s.terminate();
  });

  it('language steering can be overridden or explicitly disabled', async () => {
    const url = await start();
    const es = new SttStream({ apiKey: key, url, languageCodes: ['en', 'es'] });
    await es.connect();
    expect(decodeURIComponent(req.url!)).toContain('language_codes=["en","es"]');
    await es.terminate();

    const url2 = await start();
    const un = new SttStream({ apiKey: key, url: url2, languageCodes: [] });
    await un.connect();
    expect(req.url).not.toContain('language_codes');
    await un.terminate();
  });

  it('cuts the fed PCM into 50 ms binary frames (2400 bytes at 24 kHz PCM16) and keeps the remainder buffered', async () => {
    const url = await start();
    const s = new SttStream({ apiKey: key, url });
    await s.connect();
    s.feed(new Uint8Array(960));   // 20 ms: below one frame, buffered
    s.feed(new Uint8Array(960));   // 40 ms
    s.feed(new Uint8Array(960));   // 60 ms: one 50 ms frame goes out, 10 ms stays buffered
    await until(() => binary.length === 1);
    expect(binary[0]!.byteLength).toBe(2400);
    s.feed(new Uint8Array(1920));  // 10 + 40 = 50 ms
    await until(() => binary.length === 2);
    expect(binary.every((b) => b.byteLength === 2400)).toBe(true);
    await s.terminate();
  });

  it('parses Turn messages (partial and final) with per-word confidence, tolerating missing optional fields', async () => {
    const url = await start();
    const got: any[] = [];
    const s = new SttStream({ apiKey: key, url, onTurn: (t) => got.push(t) });
    await s.connect();
    const send = (m: unknown) => sockets[0]!.send(JSON.stringify(m));
    send({ type: 'Turn', turn_order: 0, end_of_turn: false, transcript: '2 burgers.', words: [{ text: '2', start: 0, end: 100, confidence: 0.7, word_is_final: false }] });
    send({ type: 'Turn', turn_order: 0, end_of_turn: true, transcript: '2 burgers. No, wait, make it 3.', end_of_turn_confidence: 0.99, turn_is_formatted: true, words: [{ text: 'No', start: 1, end: 2, confidence: 0.63 }] });
    send({ type: 'Turn', end_of_turn: false, transcript: 'x' }); // no words / turn_order
    await until(() => got.length === 3);
    expect(got[0]).toMatchObject({ end_of_turn: false, transcript: '2 burgers.' });
    expect(got[1]).toMatchObject({ end_of_turn: true, end_of_turn_confidence: 0.99, turn_is_formatted: true });
    expect(got[1].words[0].confidence).toBe(0.63);
    expect(got[2]).toMatchObject({ turn_order: 0, words: [], end_of_turn_confidence: null });
    await s.terminate();
  });

  it('uses the injected clock so its timeline aligns with the primary session', async () => {
    const url = await start();
    let now = 1000;
    const got: any[] = [];
    const s = new SttStream({ apiKey: key, url, clock: () => now, onTurn: (t) => got.push(t) });
    await s.connect();
    now = 4242;
    sockets[0]!.send(JSON.stringify({ type: 'Turn', turn_order: 0, end_of_turn: true, transcript: 'hi', words: [] }));
    await until(() => got.length === 1);
    expect(got[0].t_ms).toBe(4242);
    await s.terminate();
  });

  it('terminate() sends Terminate and resolves on Termination; no raw log contains the key', async () => {
    const url = await start();
    const raws: string[] = [];
    const s = new SttStream({ apiKey: key, url, onRaw: (r) => raws.push(JSON.stringify(r)) });
    await s.connect();
    await s.terminate();
    expect(text.some((m) => m.type === 'Terminate')).toBe(true);
    expect(raws.join('')).not.toContain('stt-key-000000');
  });

  it('rejects connect() if the socket closes before Begin (fail closed: no evidence stream means no evidence)', async () => {
    wss = new WebSocketServer({ port: 0 });
    await new Promise((r) => wss.once('listening', r));
    wss.on('connection', (s) => s.close(1008, 'unauthorized'));
    const url = `ws://127.0.0.1:${(wss.address() as any).port}`;
    const s = new SttStream({ apiKey: key, url });
    await expect(s.connect()).rejects.toThrow(/closed before Begin|unauthorized/);
  });
});

describe('fetchSessionTimeline (option C)', () => {
  it('sends the key to the REST host only, and NOT to the pre-signed artifact URL', async () => {
    const calls: { url: string; auth?: string }[] = [];
    const fetchImpl = (async (url: string, init?: any) => {
      calls.push({ url, auth: init?.headers?.Authorization });
      if (url.includes('/v1/sessions/')) return { ok: true, status: 200, json: async () => ({ artifacts: [{ type: 'timeline', url: 'https://storage.example/signed?sig=abc' }] }) };
      return { ok: true, status: 200, json: async () => ({ session_id: 's', started_at_unix_ms: 1, turns: [] }) };
    }) as unknown as typeof fetch;
    const tl = await fetchSessionTimeline({ apiKey: key, sessionId: 'sess_1', fetchImpl });
    expect(tl.session_id).toBe('s');
    expect(calls[0]!.auth).toBe('Bearer stt-key-000000');
    expect(calls[1]!.url).toContain('storage.example');
    expect(calls[1]!.auth).toBeUndefined();
  });
  it('fails clearly when the timeline artifact is not available yet', async () => {
    const fetchImpl = (async () => ({ ok: true, status: 200, json: async () => ({ artifacts: [] }) })) as unknown as typeof fetch;
    await expect(fetchSessionTimeline({ apiKey: key, sessionId: 'x', fetchImpl })).rejects.toThrow(/no timeline/);
  });
});
