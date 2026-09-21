// DETERMINISTIC DEMO MODE (Step 15): an in-process, SCRIPTED Voice Agent and SCRIPTED streaming-STT server on loopback. The real runtime
// (recorder, local speech check, ingest, evidence tracker, gate, committer, drift check, SQLite) connects to them exactly as it would to
// AssemblyAI, so every verdict, repair, case and order below is a genuine pipeline result. What is scripted, and labelled as such
// everywhere in the UI: the agent's decisions and speech, and the transcripts the "independent" stream returns.
// This is NOT the live managed agent and proves nothing about it (that is what the live-mic session and real-speech pass are for).
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export async function until(f: () => boolean, ms = 8000, label = 'condition'): Promise<void> {
  const t = Date.now();
  while (!f() && Date.now() - t < ms) await sleep(10);
  if (!f()) throw new Error(`demo: timeout waiting for ${label}`);
}

/** a script must never crash because the peer already hung up (the dropout scenario kills a socket on purpose) */
const safe = (f: () => unknown): void => { try { f(); } catch { /* socket closed */ } };

export interface ScriptedAgent {
  url: string; received: any[]; sockets: ServerSocket[];
  push(msg: Record<string, unknown>): void;
  /** the tool.result Tally sent for a call id, parsed */
  result(callId: string): Promise<any>;
  close(): Promise<void>;
}
export interface ScriptedStt {
  url: string; frames: number;
  speechStarted(): void; partial(text: string, order: number): void; final(text: string, order: number, confidence?: number): void; drop(): void;
  close(): Promise<void>;
}

export async function startScriptedAgent(): Promise<ScriptedAgent> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const sockets: ServerSocket[] = []; const received: any[] = [];
  wss.on('connection', (s) => {
    sockets.push(s);
    s.on('message', (d) => {
      const m = JSON.parse(d.toString());
      received.push(m);
      if (m.type === 'session.update') s.send(JSON.stringify({ type: 'session.ready', session_id: 'scripted-agent', timestamp: Date.now() / 1000 }));
    });
  });
  const latest = () => sockets[sockets.length - 1];
  return {
    url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`, received, sockets,
    push: (m) => safe(() => latest()?.send(JSON.stringify({ timestamp: Date.now() / 1000, ...m }))),
    result: async (id) => {
      await until(() => received.some((m) => m.type === 'tool.result' && m.call_id === id), 15000, `tool.result ${id}`);
      return JSON.parse(received.find((m) => m.type === 'tool.result' && m.call_id === id).result);
    },
    close: async () => { for (const s of sockets) s.terminate(); await new Promise<void>((r) => wss.close(() => r())); },
  };
}

export async function startScriptedStt(): Promise<ScriptedStt> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const sockets: ServerSocket[] = []; let frames = 0;
  wss.on('connection', (s) => {
    sockets.push(s);
    s.on('message', (d, isBin) => { if (isBin) frames++; else if (JSON.parse(d.toString()).type === 'Terminate') s.send(JSON.stringify({ type: 'Termination' })); });
    s.send(JSON.stringify({ type: 'Begin', id: 'scripted-stt', expires_at: 1 }));
  });
  const latest = () => sockets[sockets.length - 1];
  const words = (text: string, conf: number) => text.split(/\s+/).filter(Boolean).map((w) => ({ text: w, start: 0, end: 1, confidence: conf, word_is_final: true }));
  return {
    url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`,
    get frames() { return frames; },
    speechStarted: () => safe(() => latest()?.send(JSON.stringify({ type: 'SpeechStarted', timestamp: 1, confidence: 0.95 }))),
    partial: (text, order) => safe(() => latest()?.send(JSON.stringify({ type: 'Turn', turn_order: order, end_of_turn: false, transcript: text, words: words(text, 0.9) }))),
    final: (text, order, confidence = 0.9) => safe(() => latest()?.send(JSON.stringify({ type: 'Turn', turn_order: order, end_of_turn: true, transcript: text, words: words(text, confidence) }))),
    drop: () => { for (const s of sockets) s.terminate(); },
    close: async () => { for (const s of sockets) s.terminate(); await new Promise<void>((r) => wss.close(() => r())); },
  };
}
