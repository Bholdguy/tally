// Shared test rig for the gate: temp SQLite, real Store, deterministic FakeClock, a scriptable evidence source.
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TallyEvent } from '@tally/contract';
import { initDatabase } from '@tally/db';
import { FakeClock } from '../src/clock.js';
import { mintAllow } from '../src/decision.js';
import { EvidenceTracker } from '../src/evidence.js';
import { Gate, type GateOptions } from '../src/gate.js';
import { Store } from '../src/committer.js';

let uid = 0;

export interface Rig {
  store: Store; clock: FakeClock; tracker: EvidenceTracker; gate: Gate; session: string; path: string;
  up(): void; down(reason?: string): void;
  final(text: string, o?: { order?: number; conf?: number; words?: { text: string; confidence: number }[] }): void;
  partial(text: string, o?: { order?: number }): void;
  speechStarted(): void; localStart(): void; localEnd(): void;
  /** push any event (stored like the runtime would, and fed to the tracker) */
  emit(e: Record<string, unknown>): void;
  seed(...calls: { tool: string; args: Record<string, unknown> }[]): void;
  hash(): string; audit(): number; toolCalls(): { tool_name: string; status: string; conflict_type: string | null }[];
  call(tool: string, args: unknown, id?: string): Promise<ReturnType<Gate['submit']> extends Promise<infer R> ? R : never>;
  close(): void;
}

export function makeRig(over: Partial<GateOptions> & { session?: string; sharedStore?: Store; sharedPath?: string; mode?: 'live' | 'demo' | 'replay'; persist?: boolean } = {}): Rig {
  const path = over.sharedPath ?? join(mkdtempSync(join(tmpdir(), 'tally-gate-')), 't.sqlite');
  if (!over.sharedStore) initDatabase(path);
  const store = over.sharedStore ?? new Store(path);
  const session = over.session ?? 's1';
  store.createSession({ id: session, mode: over.mode ?? 'demo', config_version: 'v1' });
  store.openOrder(session);
  if (over.persist) {
    // a recording on disk + the session's evidence stored in events_raw, as the composition root does (Step 4)
    const pcm = join(mkdtempSync(join(tmpdir(), 'tally-pcm-')), `${session}.pcm`);
    writeFileSync(pcm, Buffer.alloc(9600));
    store.setAudioPointer(session, pcm);
  }
  const clock = new FakeClock();
  const tracker = new EvidenceTracker({ sttStallMs: 2500 });
  const gate = new Gate({ store, evidenceFor: () => tracker, clock, ...over });
  let turn = 0;
  const push = (e: Record<string, unknown>) => {
    const ev = { id: `e${++uid}`, session_id: session, t_ms: clock.now(), wall_ms: 0, audio_offset_ms: 0, ...e } as TallyEvent;
    tracker.ingest(ev);
    if (over.persist) {
      store.insertEventRaw({ id: ev.id, session_id: session, direction: 'in', type: ev.kind, payload: ev, t_ms: ev.t_ms, audio_offset_ms: 0 });
      if (ev.kind === 'evidence_transcript' && ev.end_of_turn) store.insertUtterance({ id: `u_${ev.id}`, session_id: session, speaker: 'user', text: ev.text, is_partial: false, t_ms: ev.t_ms, audio_offset_ms: 0, source: 'independent_stt' });
    }
  };
  const wordsOf = (text: string, conf: number) => text.split(/\s+/).filter(Boolean).map((w) => ({ text: w, confidence: conf }));
  const rig: Rig = {
    store, clock, tracker, gate, session, path,
    up: () => push({ kind: 'evidence_stream_status', status: 'up' }),
    down: (reason = 'test') => push({ kind: 'evidence_stream_status', status: 'down', reason }),
    final: (text, o = {}) => push({ kind: 'evidence_transcript', text, end_of_turn: true, turn_order: o.order ?? turn++, words: o.words ?? wordsOf(text, o.conf ?? 0.9) }),
    partial: (text, o = {}) => push({ kind: 'evidence_transcript', text, end_of_turn: false, turn_order: o.order ?? turn, words: wordsOf(text, 0.9) }),
    emit: (e) => push(e),
    speechStarted: () => push({ kind: 'evidence_speech_started' }),
    localStart: () => push({ kind: 'local_vad', state: 'speech_start' }),
    localEnd: () => push({ kind: 'local_vad', state: 'speech_end' }),
    seed: (...calls) => {
      for (const c of calls) {
        const id = `seed${++uid}`;
        const r = store.commit(mintAllow(`seedval${uid}`, session, id), { session_id: session, aai_call_id: id, tool: c.tool, args: c.args, execution_mode: 'hold' });
        if (!r.ok) throw new Error(`seed failed: ${r.error_code} ${r.message}`);
      }
    },
    hash: () => createHash('sha256').update(JSON.stringify(store.r.prepare('SELECT * FROM orders WHERE session_id=?').all(session))).digest('hex'),
    audit: () => (store.r.prepare('SELECT count(*) c FROM audit_events WHERE session_id=?').get(session) as { c: number }).c,
    toolCalls: () => store.r.prepare('SELECT tool_name,status,conflict_type FROM tool_calls WHERE session_id=? ORDER BY timestamp').all(session) as { tool_name: string; status: string; conflict_type: string | null }[],
    call: (tool, args, id) => rig.gate.submit({ session_id: session, aai_call_id: id ?? `c${++uid}`, tool, args, received_t_ms: clock.now() }),
    close: () => { if (!over.sharedStore) store.close(); },
  };
  return rig;
}
