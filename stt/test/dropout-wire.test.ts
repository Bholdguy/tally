// Dropout at the REAL SOCKET level: a real SttStream talks to a mock streaming server that kills the connection mid-hold.
// The status event must travel stream -> adapter -> tracker -> gate, and the gate must HOLD promptly (no hang, no allow).
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import type { TallyEvent } from '@tally/contract';
import { EvidenceTracker } from '../../reliability/src/evidence.js';
import { Gate } from '../../reliability/src/gate.js';
import { systemClock } from '../../reliability/src/clock.js';
import { makeRig } from '../../reliability/test/rig.js';
import { createEvidenceStream } from '../src/adapter.js';

let wss: WebSocketServer;
let server: ServerSocket[] = [];
async function start(onConn?: (s: ServerSocket) => void): Promise<string> {
  wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.once('listening', r));
  wss.on('connection', (s) => { server.push(s); s.send(JSON.stringify({ type: 'Begin', id: 'stt-x', expires_at: 1 })); onConn?.(s); });
  return `ws://127.0.0.1:${(wss.address() as any).port}`;
}
afterEach(async () => { for (const s of server) s.terminate(); server = []; await new Promise<void>((r) => wss.close(() => r())); });
const key = { reveal: () => 'k-000000' };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function wire(url: string, sttStallMs = 2500) {
  const r = makeRig({ clock: systemClock });
  const tracker = new EvidenceTracker({ sttStallMs });
  const gate = new Gate({ store: r.store, evidenceFor: () => tracker, clock: systemClock });
  const stream = createEvidenceStream({ apiKey: key, url, session_id: r.session, clock: () => performance.now(), sink: (e: TallyEvent) => tracker.ingest(e) });
  const local = (state: 'speech_start' | 'speech_end') => tracker.ingest({ id: `l${Math.random()}`, session_id: r.session, t_ms: performance.now(), wall_ms: 0, audio_offset_ms: 0, kind: 'local_vad', state } as TallyEvent);
  return { r, tracker, gate, stream, local };
}
const call = (gate: Gate, session: string, id: string) => gate.submit({ session_id: session, aai_call_id: id, tool: 'add_item', args: { item_id: 'burger', quantity: 2, modifiers: [] }, received_t_ms: 0 });

describe('dropout at the real socket level', () => {
  it('server severs the connection while a call is waiting: HOLD UNVALIDATABLE within a fraction of a second', async () => {
    const url = await start((s) => {
      setTimeout(() => s.send(JSON.stringify({ type: 'Turn', turn_order: 0, end_of_turn: true, transcript: 'Two burgers.', words: [{ text: 'Two', confidence: 0.9 }, { text: 'burgers.', confidence: 0.9 }] })), 20);
      setTimeout(() => s.send(JSON.stringify({ type: 'SpeechStarted', timestamp: 1, confidence: 0.9 })), 60);
      setTimeout(() => s.terminate(), 300);              // the drop, mid-hold
    });
    const { r, gate, stream, local } = wire(url);
    await stream.connect();
    await wait(80);                                       // Begin, first final and SpeechStarted have arrived
    local('speech_start');                                // customer is speaking a correction; not finalised yet
    const before = r.hash();
    const t0 = performance.now();
    const res = await call(gate, r.session, 'wire-1');
    const wall = performance.now() - t0;
    expect(res).toMatchObject({ verdict: 'HOLD', code: 'UNVALIDATABLE' });
    if (res.verdict !== 'HOLD') throw new Error('unreachable');
    expect(res.detail).toMatch(/stream is down/);
    expect(res.detail).toMatch(/socket (closed|error)/);
    expect(wall).toBeLessThan(1000);                      // nowhere near the 4000 ms timeout
    expect(r.hash()).toBe(before);
    r.close();
  });

  it('server accepts the connection then never says anything (silent stall): HOLD at the stall bound', async () => {
    const url = await start();                             // sends Begin only
    const { r, gate, stream, local } = wire(url, 400);
    await stream.connect();
    local('speech_start');
    const t0 = performance.now();
    const res = await call(gate, r.session, 'wire-2');
    const wall = performance.now() - t0;
    expect(res).toMatchObject({ verdict: 'HOLD', code: 'UNVALIDATABLE' });
    if (res.verdict !== 'HOLD') throw new Error('unreachable');
    expect(res.detail).toMatch(/silent while speech is in flight/);
    expect(wall).toBeGreaterThanOrEqual(380);
    expect(wall).toBeLessThan(1000);
    r.close();
  });

  it('a send failure on a dead socket reports the stream DOWN instead of crashing the audio path', async () => {
    const url = await start();
    const { r, tracker, stream } = wire(url);
    await stream.connect();
    (stream as any).ws.terminate();
    stream.feed(new Uint8Array(4800));                    // may throw inside ws; must be contained
    await wait(50);
    expect(tracker.snapshot(performance.now()).streamStatus).toBe('down');
    r.close();
  });

  it('control: with a healthy stream that finalises, the same call is judged on the evidence (ALLOW)', async () => {
    const url = await start((s) => {
      setTimeout(() => s.send(JSON.stringify({ type: 'Turn', turn_order: 0, end_of_turn: true, transcript: 'Two burgers.', words: [{ text: 'Two', confidence: 0.9 }, { text: 'burgers.', confidence: 0.9 }] })), 20);
    });
    const { r, gate, stream } = wire(url);
    await stream.connect();
    await wait(80);
    expect((await call(gate, r.session, 'wire-3')).verdict).toBe('ALLOW');
    r.close();
  });
});
