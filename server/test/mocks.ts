// Mock AssemblyAI servers for composition-root tests. They follow the DOCUMENTED protocols (and the shapes observed in the
// spikes), so they prove OUR wiring, not AssemblyAI's behaviour (that is what the spikes and live scripts are for).
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until(f: () => boolean, ms = 3000, label = 'condition') {
  const t = Date.now();
  while (!f() && Date.now() - t < ms) await wait(10);
  if (!f()) throw new Error(`timeout waiting for ${label}`);
}

/** PCM16 mono 24 kHz sine, `ms` long. amp 8000 reads as speech to the local check; 0 is digital silence. */
export function tone(ms: number, amp = 8000): Uint8Array {
  const n = Math.round((ms * 24000) / 1000);
  const out = new Uint8Array(n * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < n; i++) dv.setInt16(i * 2, Math.round(amp * Math.sin((2 * Math.PI * 220 * i) / 24000)), true);
  return out;
}

export interface MockAgent { url: string; sockets: ServerSocket[]; received: any[]; push(msg: unknown): void; audioBytes(): number; result(callId: string): Promise<any>; close(): Promise<void> }

export async function mockAgent(): Promise<MockAgent> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const sockets: ServerSocket[] = [];
  const received: any[] = [];
  wss.on('connection', (s) => {
    sockets.push(s);
    s.on('message', (d) => {
      const m = JSON.parse(d.toString());
      received.push(m);
      if (m.type === 'session.update') s.send(JSON.stringify({ type: 'session.ready', session_id: 'aai-mock', timestamp: Date.now() / 1000 }));
    });
  });
  const api: MockAgent = {
    url: `ws://127.0.0.1:${(wss.address() as any).port}`, sockets, received,
    push: (m) => sockets[sockets.length - 1]!.send(JSON.stringify({ timestamp: Date.now() / 1000, ...(m as object) })),
    audioBytes: () => received.filter((m) => m.type === 'input.audio').reduce((n, m) => n + Buffer.from(m.audio, 'base64').byteLength, 0),
    result: async (id) => { await until(() => received.some((m) => m.type === 'tool.result' && m.call_id === id), 6000, `tool.result ${id}`); return JSON.parse(received.find((m) => m.type === 'tool.result' && m.call_id === id).result); },
    close: async () => { for (const s of sockets) s.terminate(); await new Promise<void>((r) => wss.close(() => r())); },
  };
  return api;
}

export interface MockStt { url: string; sockets: ServerSocket[]; frames: Buffer[]; push(msg: unknown): void; final(text: string, order: number, conf?: number): void; partial(text: string, order: number): void; speechStarted(): void; drop(): void; bytes(): number; close(): Promise<void> }

export async function mockStt(): Promise<MockStt> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const sockets: ServerSocket[] = [];
  const frames: Buffer[] = [];
  wss.on('connection', (s) => {
    sockets.push(s);
    s.on('message', (d, isBin) => { if (isBin) frames.push(d as Buffer); else if (JSON.parse(d.toString()).type === 'Terminate') s.send(JSON.stringify({ type: 'Termination' })); });
    s.send(JSON.stringify({ type: 'Begin', id: 'stt-mock', expires_at: 1 }));
  });
  const words = (text: string, conf: number) => text.split(/\s+/).map((w) => ({ text: w, start: 0, end: 1, confidence: conf, word_is_final: true }));
  const api: MockStt = {
    url: `ws://127.0.0.1:${(wss.address() as any).port}`, sockets, frames,
    push: (m) => sockets[sockets.length - 1]?.send(JSON.stringify(m)),
    final: (text, order, conf = 0.9) => sockets[sockets.length - 1]?.send(JSON.stringify({ type: 'Turn', turn_order: order, end_of_turn: true, transcript: text, words: words(text, conf) })),
    partial: (text, order) => sockets[sockets.length - 1]?.send(JSON.stringify({ type: 'Turn', turn_order: order, end_of_turn: false, transcript: text, words: words(text, 0.9) })),
    speechStarted: () => sockets[sockets.length - 1]?.send(JSON.stringify({ type: 'SpeechStarted', timestamp: 1, confidence: 0.95 })),
    drop: () => { for (const s of sockets) s.terminate(); },
    bytes: () => frames.reduce((n, f) => n + f.byteLength, 0),
    close: async () => { for (const s of sockets) s.terminate(); await new Promise<void>((r) => wss.close(() => r())); },
  };
  return api;
}
