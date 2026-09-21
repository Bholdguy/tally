// PROTOCOL-CONFORMANCE tests against a local mock that follows the DOCUMENTED AssemblyAI protocol.
// These prove OUR client obeys the documented rules; they are NOT evidence about real API behaviour (that is the spike).
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { AgentSession, type SessionOptions } from '../src/session.js';
import { Secret } from '../src/config.js';
import { msToBytes, silence } from '../src/audio.js';

let wss: WebSocketServer;
let sockets: ServerSocket[] = [];
const received: any[] = [];
let authHeader: string | undefined;

async function start(): Promise<string> {
  wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.once('listening', r));
  wss.on('connection', (s, req) => {
    sockets.push(s);
    authHeader = req.headers.authorization;
    s.on('message', (d) => {
      const m = JSON.parse(d.toString());
      received.push(m);
      if (m.type === 'session.update') s.send(JSON.stringify({ type: 'session.ready', session_id: 'aai-1' }));
    });
  });
  return `ws://127.0.0.1:${(wss.address() as any).port}`;
}
const push = (m: unknown) => sockets[0]!.send(JSON.stringify(m));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 2000) => { const t = Date.now(); while (!f() && Date.now() - t < ms) await wait(10); if (!f()) throw new Error('until timeout'); };

afterEach(async () => { for (const s of sockets) s.terminate(); received.length = 0; sockets = []; authHeader = undefined; await new Promise<void>((r) => wss.close(() => r())); });

const mk = (url: string, over: Partial<SessionOptions> = {}) =>
  new AgentSession({
    config: { apiKey: new Secret('test-key-000000'), wsUrl: url, restUrl: 'http://x' },
    tallySessionId: 's1', mode: 'demo', configVersion: 'v1', systemPrompt: 'p', greeting: 'hi',
    handler: async () => JSON.stringify({ status: 'OK' }), ...over,
  });

describe('connection and session.update', () => {
  it('authenticates with Bearer, sends session.update FIRST with hold-mode mutating tools, and resolves at session.ready', async () => {
    const url = await start();
    const s = mk(url);
    await s.connect();
    expect(authHeader).toBe('Bearer test-key-000000');
    expect(received[0].type).toBe('session.update');
    const tools = received[0].session.tools as any[];
    expect(tools.map((t) => t.name).sort()).toEqual(['add_item', 'apply_modifier', 'confirm_order', 'get_order_state', 'remove_item', 'update_quantity']);
    for (const t of tools) expect(t.execution_mode).toBe(t.name === 'get_order_state' ? 'interactive' : 'hold');
    expect(received[0].session.input.transcription_mode).toBe('max_accuracy');
    expect(s.aaiSessionId).toBe('aai-1');
    expect(s.events[0]!.kind).toBe('session_started');
    await s.end();
  });
  it('does not put the API key in any logged raw record', async () => {
    const url = await start();
    const raws: string[] = [];
    const s = mk(url, { onRaw: (r) => raws.push(JSON.stringify(r)) });
    await s.connect();
    await s.end();
    expect(raws.join('')).not.toContain('test-key-000000');
  });
});

describe('tool calls', () => {
  it('hold-mode tool: result is sent immediately (agent is silent, no reply.done to wait for)', async () => {
    const url = await start();
    const s = mk(url);
    await s.connect();
    push({ type: 'tool.call', call_id: 'c1', name: 'add_item', arguments: { item_id: 'burger', quantity: 2, modifiers: [] } });
    await until(() => received.some((m) => m.type === 'tool.result'));
    expect(received.find((m) => m.type === 'tool.result')).toMatchObject({ call_id: 'c1' });
    await s.end();
  });
  it('interactive tool: result waits for reply.done (documented timing rule)', async () => {
    const url = await start();
    const s = mk(url);
    await s.connect();
    push({ type: 'reply.started' });
    push({ type: 'tool.call', call_id: 'c2', name: 'get_order_state', arguments: {} });
    await wait(150);
    expect(received.some((m) => m.type === 'tool.result')).toBe(false);
    push({ type: 'reply.done', status: 'completed' });
    await until(() => received.some((m) => m.type === 'tool.result'));
    await s.end();
  });
  it('interrupted reply clears pending interactive results (documented)', async () => {
    const url = await start();
    const s = mk(url);
    await s.connect();
    push({ type: 'reply.started' });
    push({ type: 'tool.call', call_id: 'c3', name: 'get_order_state', arguments: {} });
    await wait(100);
    push({ type: 'reply.done', status: 'interrupted' });
    await wait(150);
    expect(received.some((m) => m.type === 'tool.result')).toBe(false);
    await s.end();
  });
  it('a throwing handler yields an ERROR result, never a success (fail closed)', async () => {
    const url = await start();
    const s = mk(url, { handler: async () => { throw new Error('boom'); } });
    await s.connect();
    push({ type: 'tool.call', call_id: 'c4', name: 'add_item', arguments: {} });
    await until(() => received.some((m) => m.type === 'tool.result'));
    const r = JSON.parse(received.find((m) => m.type === 'tool.result').result);
    expect(r.status).toBe('ERROR');
    expect(r.code).toBe('HANDLER_FAILED');
    await s.end();
  });
  it('stamps tool_call events with monotonic t_ms and current audio offset', async () => {
    const url = await start();
    const s = mk(url);
    await s.connect();
    await s.sendPcm(silence(200));
    push({ type: 'tool.call', call_id: 'c5', name: 'remove_item', arguments: { item_id: 'fries' } });
    await until(() => s.events.some((e) => e.kind === 'tool_call'));
    const e = s.events.find((x) => x.kind === 'tool_call')!;
    expect(e.audio_offset_ms).toBeCloseTo(200, 0);
    expect(e.t_ms).toBeGreaterThanOrEqual(170); // the 10th 20 ms chunk is SENT at ~180 ms after the first (absolute schedule), not 200
    await s.end();
  });
});

describe('audio input', () => {
  it('streams at real time and accounts bytes exactly (audio_offset_ms provenance, D-05)', async () => {
    const url = await start();
    const s = mk(url);
    await s.connect();
    const t0 = performance.now();
    await s.sendPcm(new Uint8Array(msToBytes(500)));
    const dt = performance.now() - t0;
    const bytesReceived = () => received.filter((m) => m.type === 'input.audio').reduce((n, m) => n + Buffer.from(m.audio, 'base64').byteLength, 0);
    await until(() => bytesReceived() === msToBytes(500)); // frames may still be in flight when sendPcm returns
    expect(bytesReceived()).toBe(msToBytes(500));
    expect(dt).toBeGreaterThanOrEqual(450);
    await s.end();
  });
  it('sends session.end on teardown', async () => {
    const url = await start();
    const s = mk(url);
    await s.connect();
    await s.end();
    await until(() => received.some((m) => m.type === 'session.end'));
  });
});
