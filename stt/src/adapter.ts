// Adapter: independent STT stream -> normalised evidence events for Tally's evidence tracker (D-04).
// Lives in /stt (network) so /reliability stays network-free; the composition root wires `sink` to the EventSink.
import { randomUUID } from 'node:crypto';
import type { TallyEvent } from '@tally/contract';
import { SttStream, type SttOptions, type SttTurn } from './stream.js';

export interface EvidenceAdapterOptions extends Omit<SttOptions, 'onTurn' | 'onSpeechStarted' | 'onStatus'> {
  session_id: string;
  sink: (e: TallyEvent) => void;
  /** audio position of the input stream, for provenance (rule 2) */
  audioOffsetMs?: () => number;
}

export function createEvidenceStream(o: EvidenceAdapterOptions): SttStream {
  const now = () => (o.clock ? o.clock() : performance.now());
  const base = (t_ms: number) => ({ id: `evt_${randomUUID()}`, session_id: o.session_id, t_ms, wall_ms: Date.now(), audio_offset_ms: o.audioOffsetMs?.() ?? 0 });
  const stream = new SttStream({
    ...o,
    onTurn: (t: SttTurn) => o.sink({
      ...base(t.t_ms), kind: 'evidence_transcript', text: t.transcript, end_of_turn: t.end_of_turn, turn_order: t.turn_order,
      words: t.words.filter((w) => typeof w.text === 'string' && typeof w.confidence === 'number').map((w) => ({ text: w.text, confidence: w.confidence })),
    } as TallyEvent),
    onSpeechStarted: (s) => o.sink({ ...base(s.t_ms), kind: 'evidence_speech_started' } as TallyEvent),
    onStatus: (s) => o.sink({ ...base(s.t_ms ?? now()), kind: 'evidence_stream_status', status: s.status, reason: s.reason } as TallyEvent),
  });
  return stream;
}
