// SESSION RUNTIME: the composition root for one call. It is the ONE place both planes and the evidence adapters are
// instantiated and wired together (ARCHITECTURE §2):
//
//   input PCM ──► recorder (audio_pointer) ─┐
//                 independent STT stream ───┤  all fed the SAME chunks, on ONE shared session clock
//                 local speech check ───────┤
//                 Voice Agent session ──────┘
//   every event ─► Ingest (persist, with provenance) ─► EvidenceTracker ─► Gate ─► Store (sole writer)
//   Voice Agent tool.call ─► createGatedHandler ─► Gate.submit ─► tool.result back to the agent
//
// Plane 1 (agent) holds no DB handle; Plane 2 (reliability) has no network or voice path; /stt is audio-in only. This file
// only connects them.
import { randomUUID } from 'node:crypto';
import type { TallyEvent } from '@tally/contract';
import {
  AgentSession, GREETING, buildSystemPrompt, createGatedHandler, driftInstruction, menuKeyterms, type AgentConfig, type SessionOptions,
} from '@tally/agent';
import {
  EvidenceTracker, Gate, Ingest, LocalVad, PcmRecorder, PCM_BYTES_PER_MS, systemClock, type GateOptions, type IngestStats, type OrderView, type RecordedAudio, type Store, type VadOptions,
} from '@tally/reliability';
import { createEvidenceStream } from '@tally/stt';

export interface RuntimeOptions {
  agentConfig: AgentConfig;
  store: Store;
  audioDir: string;
  mode?: 'live' | 'demo' | 'replay';
  configVersion?: string;
  sessionId?: string;
  systemPrompt?: string;
  greeting?: string;
  /** gate parameters (spike A: worst evidence wait 3470 ms; word confidences 0.63-0.89) */
  evidenceWaitMaxMs?: number;
  minWordConfidence?: number;
  sttStallMs?: number;
  /** maxRepairAttempts of the active config (Step 9); regressionThreshold is above */
  maxRepairAttempts?: number;
  /** Step 7: repeats of one failure pattern before its cases are tagged regression_candidate (REGRESSION_THRESHOLD) */
  regressionThreshold?: number;
  /**
   * VALIDATION SEAM ONLY (never reachable from HTTP or env): scripts/live-repair-session.ts injects a fault into the evidence extractor so a
   * real agent can be shown a HELD verdict on demand. It exists so Plane 1's obedience to HELD / hand-off can be measured against the real agent.
   */
  gateOverrides?: Partial<Pick<GateOptions, 'extract'>>;
  /** independent evidence stream (D-04). `required` (default true): if it cannot connect, the call is NOT started (fail closed). */
  stt?: { url?: string; required?: boolean; enabled?: boolean };
  vad?: VadOptions;
  onEvent?: (e: TallyEvent) => void;
  onIngestError?: (err: unknown, e: TallyEvent) => void;
  /** test seams */
  createAgentSocket?: SessionOptions['createSocket'];
}

export interface EndSummary { session_id: string; audio: RecordedAudio; ingest: IngestStats; order: OrderView | undefined }

export class SessionRuntime {
  readonly session_id: string;
  readonly tracker: EvidenceTracker;
  readonly gate: Gate;
  readonly ingest: Ingest;
  private readonly t0 = performance.now();
  private readonly clock = () => performance.now() - this.t0;
  private readonly recorder: PcmRecorder;
  private readonly vad: LocalVad;
  private agent!: AgentSession;
  private stt?: ReturnType<typeof createEvidenceStream>;
  private readonly observers = new Set<(e: TallyEvent) => void>();
  private chain: Promise<void> = Promise.resolve();
  private nextDue = 0;
  private counter = 0;
  private summary?: EndSummary;
  private started = false;

  private constructor(private readonly o: RuntimeOptions) {
    this.session_id = o.sessionId ?? `sess_${randomUUID()}`;
    o.store.createSession({ id: this.session_id, mode: o.mode ?? 'live', config_version: o.configVersion ?? 'v1' });
    o.store.openOrder(this.session_id);
    this.recorder = new PcmRecorder(o.audioDir, this.session_id);
    o.store.setAudioPointer(this.session_id, this.recorder.pointer);
    this.tracker = new EvidenceTracker({ sttStallMs: o.sttStallMs ?? 2500 });
    // the gate shares the runtime clock so waits, stalls and evidence timestamps are all on one timeline
    this.gate = new Gate({
      store: o.store, evidenceFor: () => this.tracker, clock: { now: this.clock, sleep: systemClock.sleep },
      evidenceWaitMaxMs: o.evidenceWaitMaxMs ?? 4000, minWordConfidence: o.minWordConfidence ?? 0.6,
      onRepair: (r) => this.emit(this.base({ kind: 'repair', ...r }) as TallyEvent),
      maxRepairAttempts: o.maxRepairAttempts,
      ...o.gateOverrides,
      onWait: (w) => this.emit(this.base({ kind: 'gate_waiting', ...w }) as TallyEvent),
      onVerdict: ({ req, result }) => {
        this.emit(this.base({
          kind: 'verdict', aai_call_id: req.aai_call_id, tool: req.tool, args: req.args, verdict: result.verdict,
          ...(result.verdict === 'HOLD' ? { code: result.code, detail: result.detail } : { noop: result.noop, repaired: result.repaired }), waited_ms: result.waited_ms,
        }) as TallyEvent);
        if (result.verdict === 'ALLOW' && !result.noop) this.emitOrder();
      },
      regressionThreshold: o.regressionThreshold ?? 3,
      onCase: (c) => this.emit(this.base({ kind: 'case', ...c }) as TallyEvent),
    });
    this.ingest = new Ingest(o.store, { onError: o.onIngestError, onDerived: (e) => this.observe(e) });
    this.vad = new LocalVad(o.vad ?? {}, (t) => this.emit(this.base({ kind: 'local_vad', state: t.state })));
  }

  static async start(o: RuntimeOptions): Promise<SessionRuntime> {
    const rt = new SessionRuntime(o);
    try { await rt.connect(); rt.started = true; return rt; }
    catch (err) { await rt.abort(); throw err; }
  }

  private base<T extends Record<string, unknown>>(e: T): T & { id: string; session_id: string; t_ms: number; wall_ms: number; audio_offset_ms: number } {
    return { id: `rt_${this.session_id}_${++this.counter}`, session_id: this.session_id, t_ms: this.clock(), wall_ms: Date.now(), audio_offset_ms: this.recorder.durationMs, ...e };
  }

  /** Every event, from every source, takes this one path: persist, update the gate's evidence, notify observers. */
  private emit(e: TallyEvent): void {
    this.ingest.push(e);
    this.tracker.ingest(e);
    this.observe(e);
    if (e.kind === 'reply_started') this.replyVersion.set(e.reply_id ?? '_', this.gate.orderVersion(this.session_id));
    if (e.kind === 'transcript_agent' && e.text) this.checkSpeech(e);
  }

  /** the committed order, as the dashboard's order panel renders it (read back from the database, never from what anything said) */
  private emitOrder(): void {
    const o = this.gate.readState(this.session_id);
    if (o) this.emit(this.base({ kind: 'order', lines: o.lines, total_cents: o.total_cents, status: o.status }) as TallyEvent);
  }

  /** order version when each reply STARTED: a statement made while the order changed underneath it is ambiguous and is not "corrected" */
  private readonly replyVersion = new Map<string, string | null>();

  /**
   * STEP 10: the agent's own words are checked against the committed order. A drift becomes data (a RepairInstruction, already stored with
   * its case by the gate); THIS is where Plane 1 turns it into speech, via the adapter and the agent session. Detection can never change
   * the order, and a failure here never affects a call.
   */
  private checkSpeech(e: Extract<TallyEvent, { kind: 'transcript_agent' }>): void {
    try {
      const started = this.replyVersion.has(e.reply_id ?? '_') ? this.replyVersion.get(e.reply_id ?? '_') : undefined;
      const out = this.gate.handleAgentSpeech(this.session_id, e.text, { order_version: started, interrupted: e.interrupted, utterance_id: e.id });
      for (const r of out.repairs) this.agent?.correct(driftInstruction(r));
    } catch { /* drift handling is best effort; the order and the call are unaffected */ }
  }

  private observe(e: TallyEvent): void {
    this.o.onEvent?.(e);
    for (const f of this.observers) { try { f(e); } catch { /* an observer must not break the pipeline */ } }
  }

  /** The agent's audible reply (PCM16 mono 24 kHz), for the browser to play. Observers only; nothing here can send audio to the agent. */
  private readonly audioObservers = new Set<(pcm: Uint8Array) => void>();
  onAudio(fn: (pcm: Uint8Array) => void): () => void {
    this.audioObservers.add(fn);
    return () => this.audioObservers.delete(fn);
  }

  subscribe(fn: (e: TallyEvent) => void): () => void {
    this.observers.add(fn);
    return () => this.observers.delete(fn);
  }

  private async connect(): Promise<void> {
    const sttOpt = this.o.stt ?? {};
    if (sttOpt.enabled === false) {
      this.emit(this.base({ kind: 'evidence_stream_status', status: 'down', reason: 'independent stream disabled' }) as TallyEvent);
    } else {
      this.stt = createEvidenceStream({
        apiKey: this.o.agentConfig.apiKey, url: sttOpt.url, session_id: this.session_id, clock: this.clock,
        audioOffsetMs: () => this.recorder.durationMs, sink: (e) => this.emit(e),
      });
      try { await this.stt.connect(); }
      catch (err) {
        if (sttOpt.required !== false) throw new Error(`independent evidence stream could not connect (${err instanceof Error ? err.message : String(err)}); refusing to start a call Tally cannot validate`);
        this.emit(this.base({ kind: 'evidence_stream_status', status: 'down', reason: 'connect failed' }) as TallyEvent);
      }
    }
    this.agent = new AgentSession({
      config: this.o.agentConfig, tallySessionId: this.session_id, mode: this.o.mode ?? 'live', configVersion: this.o.configVersion ?? 'v1',
      systemPrompt: this.o.systemPrompt ?? buildSystemPrompt(), greeting: this.o.greeting ?? GREETING, keyterms: menuKeyterms(),
      handler: createGatedHandler(this.gate, this.session_id),
      clock: this.clock,
      onEvent: (e) => this.emit(e),
      // the SAME chunks go to the recorder, the independent stream and the local speech check
      onInputAudio: (pcm) => { this.recorder.append(pcm); this.stt?.feed(pcm); this.vad.feed(pcm); },
      onAudioOut: (pcm) => { for (const f of this.audioObservers) { try { f(pcm); } catch { /* an observer must not break the call */ } } },
      createSocket: this.o.createAgentSocket,
    });
    await this.agent.connect();
    this.emitOrder();                              // the order panel starts from the real (empty) committed order
    if (this.agent.aaiSessionId) this.o.store.setAaiSessionId(this.session_id, this.agent.aaiSessionId);
  }

  /**
   * Send input audio to the agent (and, through the same chunk callback, to the recorder, the independent stream and the local
   * speech check). Serialised and paced to real time across calls: the API drops frames sent faster than real time.
   */
  sendPcm(pcm: Uint8Array): Promise<void> {
    const run = async () => {
      const wait = this.nextDue - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.nextDue = Math.max(performance.now(), this.nextDue) + pcm.byteLength / PCM_BYTES_PER_MS;
      await this.agent.sendPcm(pcm);
    };
    this.chain = this.chain.then(run, run);
    return this.chain;
  }

  state() {
    return {
      session_id: this.session_id, started: this.started, ended: !!this.summary,
      evidence: this.tracker.snapshot(this.clock()), order: this.gate.readState(this.session_id),
      ingest: { ...this.ingest.stats }, audio: { bytes: this.recorder.bytesWritten, duration_ms: this.recorder.durationMs },
    };
  }

  private async abort(): Promise<void> {
    try { await this.stt?.terminate(); } catch { /* best effort */ }
    try { this.recorder.close(); } catch { /* best effort */ }
    try { this.o.store.endSession(this.session_id); } catch { /* best effort */ }
  }

  /** true once end() has completed; `endedAt` is the wall-clock ms of that moment (used to evict finished sessions from memory) */
  get ended(): boolean { return this.summary !== undefined; }
  /** 'live' | 'demo' | 'replay' (D-39: guest tier may read a 'demo' session's events/audio, never a 'live' one) */
  get mode(): 'live' | 'demo' | 'replay' { return this.o.mode ?? 'live'; }
  endedAt: number | undefined;

  async end(): Promise<EndSummary> {
    if (this.summary) return this.summary;
    // NOTE (2026-09-23, TASKS.md "Known flaky tests"): this drains the FULL real-time-paced sendPcm chain, even audio queued
    // before a client disconnect (the ws layer closing the socket does not cancel already-chained work). Normally bounded by
    // how much real audio was actually sent; a test that floods far-faster-than-real-time audio before the queue bound
    // closes it can still leave several real seconds of chain to drain here during cleanup.
    await this.chain.catch(() => undefined);
    try { await this.agent.end(); } catch { /* socket may already be closed */ }
    try { await this.stt?.terminate(); } catch { /* best effort */ }
    this.emit(this.base({ kind: 'session_ended' }) as TallyEvent);
    const audio = this.recorder.close();
    this.summary = { session_id: this.session_id, audio, ingest: { ...this.ingest.stats }, order: this.gate.readState(this.session_id) };
    this.endedAt = Date.now();
    return this.summary;
  }
}
