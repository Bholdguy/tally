import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { executionMode, toolDeclarations, type TallyEvent, type ToolName } from '@tally/contract';
import { bytesToMs, paceChunks } from './audio.js';
import type { AgentConfig } from './config.js';
import type { EventDraft } from './wire.js';
import { WireEventStream } from './wire-events.js';

export interface ToolCallInfo { aai_call_id: string; tool: string; args: unknown; received_t_ms: number }
/** Returns the tool.result payload string. In live/demo mode this MUST delegate to Tally's gate (never write the DB). */
export type ToolHandler = (call: ToolCallInfo) => Promise<string>;

export interface RawRecord {
  dir: 'in' | 'out';
  wall_ms: number;
  t_ms: number;
  audio_offset_ms: number;
  msg: unknown; // audio payloads replaced by a byte count
}

export interface SessionOptions {
  config: AgentConfig;
  tallySessionId: string;
  mode: 'live' | 'demo' | 'replay';
  configVersion: string;
  systemPrompt: string;
  greeting?: string;
  keyterms?: string[];
  handler: ToolHandler;
  onEvent?: (e: TallyEvent) => void;
  onRaw?: (r: RawRecord) => void;
  onAudioOut?: (pcm: Uint8Array) => void;
  /** Every input PCM chunk actually sent to the agent, so Tally's independent STT hears exactly the same audio (D-04). */
  onInputAudio?: (pcm: Uint8Array) => void;
  /** SPIKE B DIAGNOSTIC ONLY: force every tool's execution_mode. Never used by live/demo paths; D-19 forbids interactive gating. */
  spikeToolMode?: 'interactive';
  /** Shared session clock (ms). When set, every event is stamped with it so the agent stream, the independent STT stream, the local
   *  speech check and the gate all live on ONE timeline. Default: the session's own clock starting at connect(). */
  clock?: () => number;
  /** test seam */
  createSocket?: (url: string, headers: Record<string, string>) => WebSocket;
}

/** RMS of PCM16LE samples (0..32768). Used to distinguish real agent speech from silence frames in captures. */
export function pcmRms(buf: Uint8Array): number {
  const n = buf.byteLength >> 1;
  if (!n) return 0;
  const dv = new DataView(buf.buffer, buf.byteOffset, n * 2);
  let sum = 0;
  for (let i = 0; i < n; i++) { const s = dv.getInt16(i * 2, true); sum += s * s; }
  return Math.round(Math.sqrt(sum / n));
}

const stripAudio = (m: any): unknown => {
  if (m && typeof m === 'object') {
    if (m.type === 'input.audio' && typeof m.audio === 'string') return { ...m, audio: `<${Buffer.from(m.audio, 'base64').byteLength} bytes>` };
    if (m.type === 'reply.audio' && typeof m.data === 'string') {
      const buf = Buffer.from(m.data, 'base64');
      return { ...m, data: `<${buf.byteLength} bytes>`, rms: pcmRms(buf) }; // energy only: lets analysis tell speech from silence padding
    }
  }
  return m;
};

export class AgentSession {
  private ws!: WebSocket;
  private t0 = performance.now();
  private bytesSent = 0;
  private counter = 0;
  private lastWireType = '';
  private readonly wire: WireEventStream;
  private pendingInteractive: { call_id: string; result: string }[] = [];
  private waiters: { pred: (e: TallyEvent) => boolean; resolve: (e: TallyEvent) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }[] = [];
  private readyResolve!: () => void;
  private readyReject!: (e: Error) => void;
  private ended = false;
  aaiSessionId: string | null = null;
  readonly events: TallyEvent[] = [];

  constructor(private readonly o: SessionOptions) {
    this.wire = new WireEventStream({ mode: o.mode, config_version: o.configVersion });
  }

  private now() { return this.o.clock ? this.o.clock() : performance.now() - this.t0; }
  private audioOffset() { return bytesToMs(this.bytesSent); }

  private stamp(draft: EventDraft, raw?: unknown): TallyEvent {
    return { ...draft, id: `evt_${++this.counter}`, session_id: this.o.tallySessionId, t_ms: this.now(), wall_ms: Date.now(), audio_offset_ms: this.audioOffset(), raw } as TallyEvent;
  }

  private emit(e: TallyEvent) {
    this.events.push(e);
    this.o.onEvent?.(e);
    for (const w of [...this.waiters]) {
      if (w.pred(e)) { clearTimeout(w.timer); this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(e); }
    }
  }

  private log(dir: 'in' | 'out', msg: unknown) {
    this.o.onRaw?.({ dir, wall_ms: Date.now(), t_ms: this.now(), audio_offset_ms: this.audioOffset(), msg: stripAudio(msg) });
  }

  private send(msg: Record<string, unknown>) {
    this.log('out', msg);
    this.ws.send(JSON.stringify(msg));
  }

  connect(): Promise<void> {
    const { config } = this.o;
    const ready = new Promise<void>((res, rej) => { this.readyResolve = res; this.readyReject = rej; });
    const headers = { Authorization: `Bearer ${config.apiKey.reveal()}` };
    this.t0 = performance.now();
    this.ws = this.o.createSocket ? this.o.createSocket(config.wsUrl, headers) : new WebSocket(config.wsUrl, { headers });
    this.ws.on('open', () => this.sendSessionUpdate());
    this.ws.on('message', (data) => this.onMessage(data.toString()));
    this.ws.on('error', (err) => this.readyReject(err instanceof Error ? err : new Error(String(err))));
    this.ws.on('close', () => {
      this.ended = true;
      this.readyReject(new Error('socket closed before session.ready'));
      for (const w of this.waiters) { clearTimeout(w.timer); w.reject(new Error('socket closed')); }
      this.waiters = [];
    });
    return ready;
  }

  private sendSessionUpdate() {
    const { config, systemPrompt, greeting, keyterms } = this.o;
    // Only fields verified in the docs. Mutating tools are hold-mode (D-01) via toolDeclarations().
    this.send({
      type: 'session.update',
      session: {
        system_prompt: systemPrompt,
        ...(greeting ? { greeting } : {}),
        input: {
          format: { encoding: 'audio/pcm' },
          transcription_mode: 'max_accuracy',
          ...(keyterms?.length ? { keyterms } : {}),
        },
        output: { format: { encoding: 'audio/pcm' }, ...(config.voice ? { voice: config.voice } : {}) },
        tools: toolDeclarations().map((t) => (this.o.spikeToolMode ? { ...t, execution_mode: this.o.spikeToolMode } : t)),
      },
    });
  }

  private onMessage(text: string) {
    let msg: any;
    try { msg = JSON.parse(text); } catch { this.emit(this.stamp({ kind: 'parse_warning', message: 'non-JSON frame' })); return; }
    this.log('in', msg);
    const wireType = typeof msg?.type === 'string' ? msg.type : '';
    const out = this.wire.process(msg);
    if (out.ready) { this.aaiSessionId = out.ready.session_id; }
    for (const d of out.drafts) {
      const ev = this.stamp(d, msg);
      this.emit(ev);
      if (!out.ready && ev.kind !== 'parse_warning') this.afterEvent(ev, msg);
    }
    if (out.ready) this.readyResolve();
    if (out.audio) this.o.onAudioOut?.(out.audio);
    this.lastWireType = wireType;
  }

  private replyInFlight = false;
  private corrections: string[] = [];

  /**
   * STEP 10 (Plane 1): speak a correction of the agent's OWN earlier statement. `instructions` is built by the repair adapter from Tally's
   * data-only RepairInstruction; Tally has no path to this method (composition root only). Sent as a one-shot `reply.create`, and never on
   * top of a reply in flight: it is queued until that reply is done, so a correction cannot talk over the agent or the customer's answer.
   */
  correct(instructions: string): void {
    if (this.ended) return;
    if (this.replyInFlight) { this.corrections.push(instructions); return; }
    this.replyInFlight = true;
    this.send({ type: 'reply.create', instructions });
  }

  private afterEvent(ev: TallyEvent, _msg: unknown) {
    if (ev.kind === 'reply_started') this.replyInFlight = true;
    if (ev.kind === 'tool_call') void this.handleToolCall(ev);
    if (ev.kind === 'reply_done') {
      this.replyInFlight = false;
      const next = this.corrections.shift();
      if (next !== undefined && ev.status !== 'interrupted') queueMicrotask(() => this.correct(next));
      if (ev.status === 'interrupted') this.pendingInteractive = []; // docs: clear pending results on interruption
      else this.flushInteractive(true);
    }
  }

  private async handleToolCall(ev: Extract<TallyEvent, { kind: 'tool_call' }>) {
    let result: string;
    try {
      result = await this.o.handler({ aai_call_id: ev.aai_call_id, tool: ev.tool, args: ev.args, received_t_ms: ev.t_ms });
    } catch (err) {
      // fail closed: a handler failure is reported as an error result, never as success
      result = JSON.stringify({ status: 'ERROR', code: 'HANDLER_FAILED', message: err instanceof Error ? err.message : 'handler failed' });
    }
    if (this.ended) return;
    // An undeclared tool name is anomalous: answer it immediately (as if hold) so the result can never hang waiting for a
    // reply.done that may not come. The handler has already turned it into an ERROR (fail closed).
    const mode = this.o.spikeToolMode ?? ((['add_item', 'remove_item', 'update_quantity', 'apply_modifier', 'confirm_order', 'get_order_state'] as string[]).includes(ev.tool)
      ? executionMode(ev.tool as ToolName) : 'hold');
    if (mode === 'hold') {
      this.send({ type: 'tool.result', call_id: ev.aai_call_id, result });
    } else {
      this.pendingInteractive.push({ call_id: ev.aai_call_id, result });
      this.flushInteractive(false);
    }
  }

  /** Interactive tools: send results only once reply.done is the latest wire event (docs timing rule). */
  private flushInteractive(fromReplyDone: boolean) {
    if (!fromReplyDone && this.lastWireType !== 'reply.done') return;
    for (const p of this.pendingInteractive.splice(0)) this.send({ type: 'tool.result', call_id: p.call_id, result: p.result });
  }

  /** Stream PCM16 mono 24 kHz at real time. Tracks audio_offset_ms for provenance. */
  async sendPcm(pcm: Uint8Array, opts: { signal?: AbortSignal } = {}): Promise<void> {
    await paceChunks(pcm, (chunk) => {
      if (this.ended) return;
      this.bytesSent += chunk.byteLength;
      this.send({ type: 'input.audio', audio: Buffer.from(chunk).toString('base64') });
      this.o.onInputAudio?.(chunk);
    }, opts);
  }

  waitFor(pred: (e: TallyEvent) => boolean, timeoutMs: number, label = 'event'): Promise<TallyEvent> {
    // matches FUTURE events only; callers that need history read `this.events`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error(`timeout waiting for ${label} (${timeoutMs}ms)`));
      }, timeoutMs);
      this.waiters.push({ pred, resolve, reject, timer });
    });
  }

  async end(): Promise<void> {
    if (this.ended) return;
    try { this.send({ type: 'session.end' }); } catch { /* socket may already be closing */ }
    await new Promise<void>((res) => {
      const t = setTimeout(res, 1500);
      this.ws.once('close', () => { clearTimeout(t); res(); });
      try { this.ws.close(); } catch { res(); }
    });
    this.ended = true;
  }

  get id() { return this.o.tallySessionId; }
  static newId() { return `sess_${randomUUID()}`; }
  elapsedMs() { return this.now(); }
}
