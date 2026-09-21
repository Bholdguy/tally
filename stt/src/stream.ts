// Tally-owned independent STT stream (DECISIONS D-04, reversed 2026-09-20).
// Input-audio only: this package sends microphone/replay PCM to AssemblyAI's streaming STT and receives TRANSCRIPTS.
// It has no path to voice output and never touches the Voice Agent session, so it is independent of that session's hold
// state and of the agent's LLM. It must not import /agent, /reliability, /server (check:boundaries enforces the rules).
import WebSocket from 'ws';

export interface SttRaw { dir: 'in' | 'out'; t_ms: number; wall_ms: number; audio_offset_ms: number; msg: unknown }
export interface SttWord { text: string; start: number; end: number; confidence: number; word_is_final?: boolean }
export interface SttTurn {
  t_ms: number; wall_ms: number; audio_offset_ms: number;
  turn_order: number; end_of_turn: boolean; transcript: string; words: SttWord[];
  end_of_turn_confidence: number | null; turn_is_formatted: boolean | null;
}

export interface SttOptions {
  apiKey: { reveal(): string };
  url?: string;                    // default wss://streaming.assemblyai.com/v3/ws
  speechModel?: string;            // default universal-3-5-pro
  sampleRate?: number;             // default 24000 (same PCM the Voice Agent session is fed)
  frameMs?: number;                // outbound frame size, default 50 ms (API takes 50-1000 ms frames)
  clock?: () => number;            // share a clock with the primary session so timelines align
  onRaw?: (r: SttRaw) => void;
  onTurn?: (t: SttTurn) => void;
  /** the stream's own speech-activity signal (spike A: fires ~0.55 s after speech begins, also during a Voice Agent hold) */
  onSpeechStarted?: (s: { t_ms: number; confidence: number | null }) => void;
  /** connection health. 'down' is emitted on error OR close, exactly once, so the gate can fail closed promptly (D-04) */
  onStatus?: (s: { status: 'up' | 'down'; reason?: string; t_ms: number }) => void;
  createSocket?: (url: string, headers: Record<string, string>) => WebSocket; // test seam
}

export class SttStream {
  private ws!: WebSocket;
  private buf: Uint8Array = new Uint8Array(0);
  private bytesFed = 0;
  private closed = false;
  private beginResolve!: () => void;
  private beginReject!: (e: Error) => void;
  private termResolve: (() => void) | null = null;
  readonly turns: SttTurn[] = [];
  sessionId: string | null = null;
  private readonly t0 = performance.now();

  constructor(private readonly o: SttOptions) {}

  private now() { return this.o.clock ? this.o.clock() : performance.now() - this.t0; }
  private offsetMs() { return this.bytesFed / ((this.o.sampleRate ?? 24000) * 2 / 1000); }
  private log(dir: 'in' | 'out', msg: unknown) { this.o.onRaw?.({ dir, t_ms: this.now(), wall_ms: Date.now(), audio_offset_ms: this.offsetMs(), msg }); }

  connect(): Promise<void> {
    const rate = this.o.sampleRate ?? 24000;
    const base = this.o.url ?? 'wss://streaming.assemblyai.com/v3/ws';
    const qs = new URLSearchParams({ speech_model: this.o.speechModel ?? 'universal-3-5-pro', sample_rate: String(rate), encoding: 'pcm_s16le' });
    const headers = { Authorization: this.o.apiKey.reveal() }; // documented: API key, no "Bearer" prefix
    const ready = new Promise<void>((res, rej) => { this.beginResolve = res; this.beginReject = rej; });
    this.ws = this.o.createSocket ? this.o.createSocket(`${base}?${qs}`, headers) : new WebSocket(`${base}?${qs}`, { headers });
    this.ws.on('message', (d, isBinary) => {
      if (isBinary) return;
      let m: any;
      try { m = JSON.parse(d.toString()); } catch { return; }
      this.log('in', m);
      if (m.type === 'Begin') { this.sessionId = m.id ?? null; this.beginResolve(); this.o.onStatus?.({ status: 'up', t_ms: this.now() }); }
      else if (m.type === 'SpeechStarted') this.o.onSpeechStarted?.({ t_ms: this.now(), confidence: typeof m.confidence === 'number' ? m.confidence : null });
      else if (m.type === 'Turn') {
        const t: SttTurn = {
          t_ms: this.now(), wall_ms: Date.now(), audio_offset_ms: this.offsetMs(),
          turn_order: Number(m.turn_order ?? 0), end_of_turn: !!m.end_of_turn, transcript: String(m.transcript ?? ''),
          words: Array.isArray(m.words) ? m.words : [],
          end_of_turn_confidence: typeof m.end_of_turn_confidence === 'number' ? m.end_of_turn_confidence : null,
          turn_is_formatted: typeof m.turn_is_formatted === 'boolean' ? m.turn_is_formatted : null,
        };
        this.turns.push(t);
        this.o.onTurn?.(t);
      } else if (m.type === 'Termination') this.termResolve?.();
    });
    this.ws.on('error', (e) => { this.beginReject(e instanceof Error ? e : new Error(String(e))); this.markDown(`socket error: ${e instanceof Error ? e.message : String(e)}`); });
    this.ws.on('close', (code, reason) => {
      this.closed = true;
      this.markDown(`socket closed (code ${code}${reason?.length ? ' ' + reason.toString() : ''})`);
      this.beginReject(new Error(`stt socket closed before Begin (code ${code} ${reason?.toString() ?? ''})`));
      this.termResolve?.();
    });
    return ready;
  }

  private downEmitted = false;
  private markDown(reason: string): void {
    if (this.downEmitted) return;
    this.downEmitted = true;
    this.o.onStatus?.({ status: 'down', reason, t_ms: this.now() });
  }

  /** Feed the SAME PCM16 the primary session receives. Frames are cut to frameMs and sent as binary. */
  feed(pcm: Uint8Array): void {
    if (this.closed) return;
    const frameBytes = Math.round(((this.o.frameMs ?? 50) * (this.o.sampleRate ?? 24000) * 2) / 1000) & ~1;
    const merged = new Uint8Array(this.buf.byteLength + pcm.byteLength);
    merged.set(this.buf); merged.set(pcm, this.buf.byteLength);
    let o = 0;
    for (; o + frameBytes <= merged.byteLength; o += frameBytes) {
      const frame = merged.subarray(o, o + frameBytes);
      this.bytesFed += frame.byteLength;
      this.log('out', { type: 'audio_frame', bytes: frame.byteLength });
      try { this.ws.send(frame, { binary: true }); }
      catch (e) { this.markDown(`send failed: ${e instanceof Error ? e.message : String(e)}`); this.closed = true; return; } // never crash the audio path; report down
    }
    this.buf = merged.slice(o);
  }

  /** Test/diagnostic hook: abruptly kill the socket, as a network drop would (no Terminate handshake). */
  sever(): void {
    try { this.ws.terminate(); } catch { /* already gone */ }
  }

  async terminate(): Promise<void> {
    if (this.closed) return;
    const done = new Promise<void>((res) => { this.termResolve = res; setTimeout(res, 3000); });
    try { this.log('out', { type: 'Terminate' }); this.ws.send(JSON.stringify({ type: 'Terminate' })); } catch { /* closing */ }
    await done;
    try { this.ws.close(); } catch { /* already closed */ }
    this.closed = true;
  }
}
