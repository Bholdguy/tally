// INGEST (Step 4): the EventSink. Every normalised event (Voice Agent stream, independent STT, local speech check) is
// persisted with provenance: lossless `events_raw`, then `utterances`, `vad_events` and `entities` derived from it, plus the
// derived barge-in. Persistence never affects the gate's decision path (the gate reads the EvidenceTracker, not the DB), so a
// storage failure is counted and reported but cannot allow or block a call.
import type { TallyEvent } from '@tally/contract';
import { modifierClass } from '@tally/contract';
import type { Store } from './committer.js';
import { BargeInDeriver } from './bargein.js';
import { foldUtterance, newEvidenceState, type EvidenceState } from './extractor.js';

export interface IngestStats { events: number; errors: number; utterances: number; entities: number; vad: number; barge_ins: number }

/** Word-level normalised edit distance between the last partial and the final of a turn (D-03 text-instability). 0 = stable. */
export function textInstability(partial: string, final: string): number {
  const tok = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const a = tok(partial), b = tok(final);
  if (!a.length && !b.length) return 0;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length]![b.length]! / Math.max(a.length, b.length);
}

const stripRaw = (e: TallyEvent) => { const { raw: _raw, ...rest } = e as TallyEvent & { raw?: unknown }; return { ...rest, raw: (e as { raw?: unknown }).raw }; };

interface Snap { qty: number | null; mods: string[]; removed: boolean }

export class Ingest {
  readonly stats: IngestStats = { events: 0, errors: 0, utterances: 0, entities: 0, vad: 0, barge_ins: 0 };
  private readonly barge = new BargeInDeriver();
  private readonly lastPartial = new Map<string, string>();       // turn key -> last partial text (instability)
  private readonly evidence = new Map<string, EvidenceState>();    // session -> cumulative evidence (for entity diffs)
  private readonly lastEntity = new Map<string, string>();         // `${session}|${type}|${ref}` -> entity id (supersession)

  constructor(private readonly store: Store, private readonly opts: { onError?: (err: unknown, e: TallyEvent) => void; onDerived?: (e: TallyEvent) => void } = {}) {}

  push(e: TallyEvent): void {
    try {
      this.persist(e);
      // barge-in is derived from the AGENT stream only
      const derived = this.barge.ingest(e);
      if (derived) { this.stats.barge_ins++; this.persist(derived); this.opts.onDerived?.(derived); }
    } catch (err) {
      this.stats.errors++;
      this.opts.onError?.(err, e);
    }
  }

  private persist(e: TallyEvent): void {
    const s = this.store;
    this.stats.events++;
    s.insertEventRaw({ id: e.id, session_id: e.session_id, direction: 'in', type: e.kind, payload: stripRaw(e), t_ms: e.t_ms, audio_offset_ms: e.audio_offset_ms, server_ts_ms: e.server_ts_ms ?? null });

    switch (e.kind) {
      case 'transcript_user_delta': {
        const key = `agent:${e.item_id ?? 'u'}`;
        this.lastPartial.set(key, e.text);
        this.utterance(e, { speaker: 'user', text: e.text, partial: true, source: 'agent_stream', item_id: e.item_id });
        break;
      }
      case 'transcript_user': {
        const key = `agent:${e.item_id ?? 'u'}`;
        const prev = this.lastPartial.get(key);
        this.lastPartial.delete(key);
        this.utterance(e, { speaker: 'user', text: e.text, partial: false, source: 'agent_stream', item_id: e.item_id, instability: prev === undefined ? null : textInstability(prev, e.text) });
        break;
      }
      case 'transcript_agent':
        this.utterance(e, { speaker: 'agent', text: e.text, partial: false, source: 'agent_stream', item_id: e.item_id, reply_id: e.reply_id, interrupted: e.interrupted ?? null });
        break;
      case 'evidence_transcript': {
        const key = `indep:${e.session_id}:${e.turn_order}`;
        const prev = this.lastPartial.get(key);
        if (e.end_of_turn) this.lastPartial.delete(key); else this.lastPartial.set(key, e.text);
        const confs = (e.words ?? []).map((w) => w.confidence);
        const uid = this.utterance(e, {
          speaker: 'user', text: e.text, partial: !e.end_of_turn, source: 'independent_stt',
          confidence: confs.length ? Math.min(...confs) : null, words_json: e.words?.length ? JSON.stringify(e.words) : null,
          instability: e.end_of_turn && prev !== undefined ? textInstability(prev, e.text) : null,
        });
        if (e.end_of_turn) this.entities(e, uid);
        break;
      }
      case 'input_speech_started': this.vad(e, 'speech_start', 'agent'); break;
      case 'input_speech_stopped': this.vad(e, 'speech_end', 'agent'); break;
      case 'evidence_speech_started': this.vad(e, 'speech_start', 'independent'); break;
      case 'local_vad': this.vad(e, e.state, 'local'); break;
      case 'barge_in':
        this.store.insertVad({ id: e.id, session_id: e.session_id, type: 'barge_in', t_ms: e.t_ms, derived: true, source_event_ids: e.source_event_ids, source: 'derived', reaction_ms: e.reaction_ms ?? null });
        this.stats.vad++;
        break;
      case 'session_ended': s.endSession(e.session_id); break;
      default: break;
    }
  }

  private utterance(e: TallyEvent, u: { speaker: 'user' | 'agent'; text: string; partial: boolean; source: 'agent_stream' | 'independent_stt'; item_id?: string; reply_id?: string; interrupted?: boolean | null; confidence?: number | null; words_json?: string | null; instability?: number | null }): string {
    const id = `utt_${e.id}`;
    this.store.insertUtterance({
      id, session_id: e.session_id, speaker: u.speaker, text: u.text, is_partial: u.partial, confidence: u.confidence ?? null, t_ms: e.t_ms,
      audio_offset_ms: e.audio_offset_ms, item_id: u.item_id ?? null, reply_id: u.reply_id ?? null, interrupted: u.interrupted ?? null,
      instability: u.instability ?? null, source: u.source, server_ts_ms: e.server_ts_ms ?? null, words_json: u.words_json ?? null,
    });
    this.stats.utterances++;
    return id;
  }

  private vad(e: TallyEvent, type: 'speech_start' | 'speech_end', source: 'agent' | 'local' | 'independent'): void {
    this.store.insertVad({ id: `vad_${e.id}`, session_id: e.session_id, type, t_ms: e.t_ms, derived: false, source, source_event_ids: [e.id] });
    this.stats.vad++;
  }

  /** Entities from the customer's FINAL independent utterances, each pointing at the utterance that produced it (rule 2). */
  private entities(e: Extract<TallyEvent, { kind: 'evidence_transcript' }>, utteranceId: string): void {
    const sid = e.session_id;
    const state = this.evidence.get(sid) ?? newEvidenceState();
    this.evidence.set(sid, state);
    const before = new Map<string, Snap>([...state.items].map(([k, v]) => [k, { qty: v.quantity, mods: [...v.modifiers], removed: v.removed }]));
    const cuesBefore = state.cueCount;
    const pickupBefore = JSON.stringify(state.pickup);
    foldUtterance(state, { text: e.text, words: e.words });
    const cue = state.cueCount > cuesBefore ? 'correction' : null;

    const put = (type: 'item' | 'quantity' | 'modifier' | 'removal' | 'substitution' | 'pickup_time', value: string, ref: string | null) => {
      const key = `${sid}|${type}|${ref ?? ''}${type === 'modifier' || type === 'removal' || type === 'substitution' ? `|${value}` : ''}`;
      const id = `ent_${utteranceId}_${type}_${(ref ?? 'x')}_${value}`.replace(/[^A-Za-z0-9_.-]/g, '_');
      this.store.insertEntity({ id, session_id: sid, type, value, source_utterance_id: utteranceId, item_ref: ref, cue });
      const prev = this.lastEntity.get(key);
      if (prev && prev !== id) this.store.supersedeEntity(prev, id);
      this.lastEntity.set(key, id);
      this.stats.entities++;
    };

    for (const [item, ev] of state.items) {
      const b = before.get(item);
      if (!b) put('item', item, item);
      if (ev.removed && !b?.removed) put('removal', item, item);
      if (!ev.removed && ev.quantity !== null && (b?.qty !== ev.quantity || b?.removed)) put('quantity', String(ev.quantity), item);
      for (const m of ev.modifiers) {
        if (b?.mods.includes(m)) continue;
        const cls = modifierClass(m);
        put(cls === 'removal' ? 'removal' : cls === 'substitution' ? 'substitution' : 'modifier', m, item);
      }
    }
    if (JSON.stringify(state.pickup) !== pickupBefore && state.pickup) {
      put('pickup_time', state.pickup.kind === 'asap' ? 'ASAP' : `${state.pickup.hour}:${String(state.pickup.minute).padStart(2, '0')}${state.pickup.meridiem ?? ''}`, null);
    }
  }
}
