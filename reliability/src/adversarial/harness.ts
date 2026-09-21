// The adversarial bench (Step 14): the REAL gate, evidence tracker, extractor, committer and SQLite on a virtual clock, in a throwaway
// database. No part of the gate is mocked; only the SOURCES of evidence and calls are scripted so a lie can be told on purpose.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TallyEvent } from '@tally/contract';
import { initDatabase } from '@tally/db';
import { FakeClock } from '../clock.js';
import { Store } from '../committer.js';
import { EvidenceTracker } from '../evidence.js';
import { Gate, type GateOptions } from '../gate.js';
import type { OrderState } from '../order.js';

let uid = 0;
/** test seam: run the whole corpus against a deliberately BROKEN gate build (the harness must then fail) */
let override: Partial<GateOptions> = {};
export const withGateOverride = async <T>(o: Partial<GateOptions>, f: () => Promise<T>): Promise<T> => { const prev = override; override = o; try { return await f(); } finally { override = prev; } };
export type GateResultOf = Awaited<ReturnType<Gate['submit']>>;

export class Bench {
  private constructor(readonly store: Store, readonly clock: FakeClock, readonly tracker: EvidenceTracker, readonly gate: Gate, readonly session: string, private readonly dir: string) {}

  /** `persist:false` keeps cases off (a replay-mode session); the bench always uses a replay-mode session so `seed` is legal and no real order is ever involved */
  static create(over: Partial<GateOptions> = {}): Bench {
    const dir = mkdtempSync(join(tmpdir(), 'tally-adv-'));
    const path = join(dir, 'adv.sqlite');
    initDatabase(path);
    const store = new Store(path);
    const session = `adv_${++uid}`;
    store.createSession({ id: session, mode: 'replay', config_version: 'adversarial' });
    store.openOrder(session);
    const clock = new FakeClock();
    const tracker = new EvidenceTracker({ sttStallMs: 2500 });
    const gate = new Gate({ store, evidenceFor: () => tracker, clock, ...override, ...over });
    return new Bench(store, clock, tracker, gate, session, dir);
  }

  private push(e: Record<string, unknown>): void {
    this.tracker.ingest({ id: `adv${++uid}`, session_id: this.session, t_ms: this.clock.now(), wall_ms: 0, audio_offset_ms: 0, ...e } as TallyEvent);
  }
  private turn = 0;
  up(): void { this.push({ kind: 'evidence_stream_status', status: 'up' }); }
  down(reason = 'adversarial'): void { this.push({ kind: 'evidence_stream_status', status: 'down', reason }); }
  final(text: string, o: { order?: number; conf?: number } = {}): void {
    this.push({ kind: 'evidence_transcript', text, end_of_turn: true, turn_order: o.order ?? this.turn++, words: text.split(/\s+/).filter(Boolean).map((w) => ({ text: w, confidence: o.conf ?? 0.9 })) });
  }
  partial(text: string, order: number): void { this.push({ kind: 'evidence_transcript', text, end_of_turn: false, turn_order: order, words: text.split(/\s+/).filter(Boolean).map((w) => ({ text: w, confidence: 0.9 })) }); }
  speechStarted(): void { this.push({ kind: 'evidence_speech_started' }); }
  localStart(): void { this.push({ kind: 'local_vad', state: 'speech_start' }); }
  localEnd(): void { this.push({ kind: 'local_vad', state: 'speech_end' }); }
  seed(state: Partial<OrderState> & { lines: OrderState['lines'] }): void { this.store.seedReplayOrder(this.session, { status: 'open', pickup_time: null, ...state }); }
  call(tool: string, args: unknown, id?: string): Promise<GateResultOf> {
    return this.gate.submit({ session_id: this.session, aai_call_id: id ?? `adv_call_${++uid}`, tool, args, received_t_ms: this.clock.now() });
  }
  say(text: string, ctx: Parameters<Gate['handleAgentSpeech']>[2] = {}) { return this.gate.handleAgentSpeech(this.session, text, { utterance_id: `u${++uid}`, ...ctx }); }
  order() { return this.store.getOrder(this.session)!; }
  linesJson(): string { return JSON.stringify(this.order().state.lines); }
  close(): void { try { this.store.close(); } catch { /* already closed */ } try { rmSync(this.dir, { recursive: true, force: true }); } catch { /* temp cleanup */ } }
}
