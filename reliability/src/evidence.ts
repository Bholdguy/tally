// Evidence tracker (DECISIONS D-04): per-session state of what the independent STT stream and the local speech check
// say about the CUSTOMER, and whether that evidence is complete enough to judge a tool call. Pure state machine over
// TallyEvents; no timers, no network (the stream adapter lives in /stt). Fail-closed: anything unknown means "not ready".
import type { TallyEvent } from '@tally/contract';
import type { EvidenceUtterance } from './extractor.js';

export type StreamStatus = 'unknown' | 'up' | 'down';

interface Turn { order: number; text: string; final: boolean; words: { text: string; confidence: number }[]; t: number }
interface LocalRun { start: number; end: number | null }

export interface EvidenceSnapshot {
  streamStatus: StreamStatus;
  streamReason?: string;
  /** someone is (or was just) speaking and the independent stream has not finished with it */
  speechInFlight: boolean;
  /** speech is in flight but the independent stream has produced NO signal for it within `sttStallMs` (dead/stalled stream?) */
  stalled: boolean;
  reasons: string[];
  /** finalised utterances, in order (cumulative for the session) */
  finals: EvidenceUtterance[];
  finalTurnOrders: number[];
  partial?: EvidenceUtterance;
  lastEvidenceAt: number | null;
}

export interface EvidenceOptions { sttStallMs?: number }

export class EvidenceTracker {
  private readonly stallMs: number;
  private status: StreamStatus = 'unknown';
  private reason?: string;
  private turns = new Map<number, Turn>();
  private lastFinalAt = -Infinity;
  private lastIndepSignalAt = -Infinity;   // SpeechStarted or any Turn
  private lastSpeechStartedAt = -Infinity;
  private runs: LocalRun[] = [];
  private lastEvidenceAt: number | null = null;

  constructor(opts: EvidenceOptions = {}) { this.stallMs = opts.sttStallMs ?? 2500; }

  ingest(e: TallyEvent): void {
    switch (e.kind) {
      case 'evidence_stream_status':
        this.status = e.status; this.reason = e.reason;
        break;
      case 'evidence_speech_started':
        this.lastSpeechStartedAt = e.t_ms; this.lastIndepSignalAt = e.t_ms; this.lastEvidenceAt = e.t_ms;
        break;
      case 'evidence_transcript': {
        this.turns.set(e.turn_order, { order: e.turn_order, text: e.text, final: e.end_of_turn, words: e.words ?? [], t: e.t_ms });
        this.lastIndepSignalAt = e.t_ms; this.lastEvidenceAt = e.t_ms;
        if (e.end_of_turn) this.lastFinalAt = e.t_ms;
        break;
      }
      case 'local_vad':
        if (e.state === 'speech_start') this.runs.push({ start: e.t_ms, end: null });
        else { const r = this.runs[this.runs.length - 1]; if (r && r.end === null) r.end = e.t_ms; }
        break;
      default:
        break;
    }
  }

  snapshot(now: number): EvidenceSnapshot {
    const reasons: string[] = [];
    const ordered = [...this.turns.values()].sort((a, b) => a.order - b.order);
    const finals = ordered.filter((t) => t.final);
    const lastFinalOrder = finals.length ? finals[finals.length - 1]!.order : -1;
    const partialTurn = ordered.find((t) => !t.final && t.order > lastFinalOrder) ?? ordered.find((t) => !t.final);
    const asUtt = (t: Turn): EvidenceUtterance => ({ text: t.text, words: t.words });

    let inFlight = false;
    let stalled = false;

    // independent stream's own view
    if (this.lastSpeechStartedAt > this.lastFinalAt) { inFlight = true; reasons.push('independent SpeechStarted without a following final'); }
    if (partialTurn && !partialTurn.final && partialTurn.t > this.lastFinalAt) { inFlight = true; reasons.push('independent partial transcript not yet finalised'); }

    // local speech check bridges the lag before the independent stream reacts
    const run = this.runs[this.runs.length - 1];
    if (run) {
      const acknowledged = this.lastIndepSignalAt > run.start; // strictly AFTER onset: an earlier or same-instant signal is not an acknowledgment
      const resolved = run.end !== null && this.lastFinalAt >= run.end;
      if (!resolved) {
        inFlight = true;
        reasons.push(run.end === null ? 'local speech check: customer speaking now' : 'local speech check: speech ended, independent final not yet received');
        if (!acknowledged && now - run.start > this.stallMs) {
          stalled = true;
          reasons.push(`no independent-stream signal ${Math.round(now - run.start)} ms after local speech began`);
        }
      }
    }
    return {
      streamStatus: this.status, streamReason: this.reason, speechInFlight: inFlight, stalled, reasons,
      finals: finals.map(asUtt), finalTurnOrders: finals.map((t) => t.order),
      partial: partialTurn ? asUtt(partialTurn) : undefined, lastEvidenceAt: this.lastEvidenceAt,
    };
  }
}
