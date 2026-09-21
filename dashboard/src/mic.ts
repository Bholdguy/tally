// The dashboard mic page: browser microphone -> THIS server's /ws/mic (authenticated by its first frame; a token in a URL would leak into
// logs) -> the runtime (agent + recorder + independent STT + local speech check). The agent's audible reply comes back over the same
// socket as PCM16 24 kHz frames and is played here. The browser never talks to AssemblyAI and holds no AssemblyAI credential.

export const TARGET_RATE = 24000;
export const FRAME_SAMPLES = 480; // 20 ms at 24 kHz

/** linear-interpolation resampler (mono Float32) */
export function downsample(input: Float32Array, inRate: number, outRate = TARGET_RATE): Float32Array {
  if (outRate === inRate) return input;
  const ratio = inRate / outRate;
  const n = Math.floor(input.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const pos = i * ratio; const i0 = Math.floor(pos); const i1 = Math.min(input.length - 1, i0 + 1); const f = pos - i0;
    out[i] = input[i0]! * (1 - f) + input[i1]! * f;
  }
  return out;
}
export function floatToPcm16(f: Float32Array): Uint8Array {
  const out = new Uint8Array(f.length * 2); const dv = new DataView(out.buffer);
  for (let i = 0; i < f.length; i++) { const s = Math.max(-1, Math.min(1, f[i]!)); dv.setInt16(i * 2, Math.round(s < 0 ? s * 32768 : s * 32767), true); }
  return out;
}
export function pcm16ToFloat(b: Uint8Array): Float32Array {
  const n = b.byteLength >> 1; const out = new Float32Array(n); const dv = new DataView(b.buffer, b.byteOffset, n * 2);
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true) / 32768;
  return out;
}
/** collects arbitrary-size sample blocks into exact 20 ms frames (the server refuses oversize frames and faster-than-real-time senders) */
export class Framer {
  private buf: number[] = [];
  push(samples: Float32Array): Uint8Array[] {
    for (const s of samples) this.buf.push(s);
    const frames: Uint8Array[] = [];
    while (this.buf.length >= FRAME_SAMPLES) frames.push(floatToPcm16(Float32Array.from(this.buf.splice(0, FRAME_SAMPLES))));
    return frames;
  }
}

export interface Mic { start(session: string, token: string, onState: (s: string) => void): Promise<void>; stop(): void; active(): boolean }

export function createMic(): Mic {
  let ws: WebSocket | null = null; let ctx: AudioContext | null = null; let stream: MediaStream | null = null; let node: ScriptProcessorNode | null = null;
  let playAt = 0;
  const stop = () => {
    try { node?.disconnect(); } catch { /* already gone */ }
    stream?.getTracks().forEach((t) => t.stop());
    try { ws?.close(); } catch { /* already closed */ }
    void ctx?.close().catch(() => undefined);
    ws = null; ctx = null; stream = null; node = null; playAt = 0;
  };
  return {
    active: () => ws !== null,
    stop,
    start: async (session, token, onState) => {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false } });
      ctx = new AudioContext();
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const sock = new WebSocket(`${proto}://${location.host}/ws/mic`);
      ws = sock; sock.binaryType = 'arraybuffer';
      const framer = new Framer();
      await new Promise<void>((resolve, reject) => {
        sock.onopen = () => sock.send(JSON.stringify({ session, token }));      // first frame authenticates
        sock.onerror = () => reject(new Error('mic socket error'));
        sock.onclose = (e) => { onState(`mic closed (${e.reason || e.code})`); stop(); reject(new Error(e.reason || 'closed')); };
        sock.onmessage = (m) => {
          if (typeof m.data === 'string') { if (JSON.parse(m.data).type === 'ready') { onState('mic on'); resolve(); } return; }
          // agent audio: play it, scheduled back to back
          const f = pcm16ToFloat(new Uint8Array(m.data as ArrayBuffer));
          if (!ctx || !f.length) return;
          const b = ctx.createBuffer(1, f.length, TARGET_RATE); b.getChannelData(0).set(f);
          const src = ctx.createBufferSource(); src.buffer = b; src.connect(ctx.destination);
          playAt = Math.max(playAt, ctx.currentTime); src.start(playAt); playAt += b.duration;
        };
      });
      const source = ctx.createMediaStreamSource(stream);
      node = ctx.createScriptProcessor(4096, 1, 1);
      // real-time only: the server drops the connection of a client that sends faster than real time
      node.onaudioprocess = (ev) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        for (const fr of framer.push(downsample(ev.inputBuffer.getChannelData(0), ctx!.sampleRate))) ws.send(fr);
      };
      source.connect(node); node.connect(ctx.destination);
    },
  };
}
