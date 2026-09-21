// Pure helpers for the REAL-SPEECH validation pass (TESTING.md §11, docs/real-speech-validation.md): WAV loading, comparison of
// what was committed against what the speaker wrote down BEFORE speaking, and the FIXED pass criteria (set in advance so they
// cannot be tuned after seeing results).
import { computeTotalCents } from '@tally/contract';

// ---------------------------------------------------------------- audio
export interface Wav { sampleRate: number; channels: number; pcm16: Int16Array }

/** Parse a PCM16 WAV (mono or stereo, any sample rate). Other formats are rejected with a clear message (convert first). */
export function parseWav(buf: Uint8Array): Wav {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number) => String.fromCharCode(...buf.subarray(o, o + 4));
  if (buf.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  let o = 12;
  while (o + 8 <= buf.byteLength) {
    const id = tag(o); const size = dv.getUint32(o + 4, true);
    if (id === 'fmt ') fmt = { format: dv.getUint16(o + 8, true), channels: dv.getUint16(o + 10, true), rate: dv.getUint32(o + 12, true), bits: dv.getUint16(o + 22, true) };
    if (id === 'data') {
      if (!fmt) throw new Error('data chunk before fmt chunk');
      if (fmt.format !== 1 || fmt.bits !== 16) throw new Error(`only 16-bit PCM WAV is supported (got format ${fmt.format}, ${fmt.bits}-bit); convert first, e.g. ffmpeg -i in.m4a -ac 1 -ar 24000 -sample_fmt s16 out.wav`);
      const n = Math.min(size, buf.byteLength - (o + 8)) >> 1;
      const pcm = new Int16Array(n);
      for (let i = 0; i < n; i++) pcm[i] = dv.getInt16(o + 8 + i * 2, true);
      return { sampleRate: fmt.rate, channels: fmt.channels, pcm16: pcm };
    }
    o += 8 + size + (size & 1);
  }
  throw new Error('WAV has no data chunk');
}

/** Downmix to mono and linearly resample to 24 kHz PCM16LE bytes (what the Voice Agent API takes). */
export function toPcm24k(w: Wav): Uint8Array {
  const frames = Math.floor(w.pcm16.length / w.channels);
  const mono = new Float64Array(frames);
  for (let i = 0; i < frames; i++) { let s = 0; for (let c = 0; c < w.channels; c++) s += w.pcm16[i * w.channels + c]!; mono[i] = s / w.channels; }
  const outLen = Math.round((frames * 24000) / w.sampleRate);
  const out = new Uint8Array(outLen * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < outLen; i++) {
    const src = (i * w.sampleRate) / 24000; const i0 = Math.floor(src); const f = src - i0;
    const a = mono[Math.min(i0, frames - 1)]!; const b = mono[Math.min(i0 + 1, frames - 1)]!;
    dv.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(a + (b - a) * f))), true);
  }
  return out;
}

/** RMS of the first `ms` of a 24 kHz PCM16 buffer: a room-noise calibration when the recording starts with the speaker silent. */
export function estimateNoiseFloor(pcm: Uint8Array, ms = 500): number {
  const n = Math.min(pcm.byteLength >> 1, Math.round((ms * 24000) / 1000));
  if (!n) return 0;
  const dv = new DataView(pcm.buffer, pcm.byteOffset, n * 2);
  let sum = 0;
  for (let i = 0; i < n; i++) { const s = dv.getInt16(i * 2, true); sum += s * s; }
  return Math.sqrt(sum / n);
}

// ---------------------------------------------------------------- intent and comparison
export type RecordingKind = 'clean' | 'inline_correction' | 'late_correction' | 'imperfect_correction' | 'overlapping_correction' | 'backchannel' | 'noise';
export interface IntendedItem { item_id: string; quantity: number; modifiers: string[] }
/** Written by the speaker BEFORE speaking: the ground truth. Never derived from any transcript. */
export interface Intent {
  speaker: string; scenario: string; kind: RecordingKind; noise?: string;
  intended: { items: IntendedItem[]; pickup: 'ASAP' | string };
  /** calls the speaker EXPECTS to be held (they seed a deliberate disagreement, e.g. a correction after the agent's call) */
  notes?: string;
}
export interface OrderLineLite { item_id: string; quantity: number; modifiers: string[] }

const norm = (l: OrderLineLite[]) => l.map((x) => ({ item_id: x.item_id, quantity: x.quantity, modifiers: [...x.modifiers].sort() })).sort((a, b) => a.item_id.localeCompare(b.item_id));
export const sameOrder = (a: OrderLineLite[], b: OrderLineLite[]): boolean => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

export interface OrderDiff { equal: boolean; missing: string[]; extra: string[]; wrong: string[] }
export function diffOrder(committed: OrderLineLite[], intended: IntendedItem[]): OrderDiff {
  const c = new Map(norm(committed).map((x) => [x.item_id, x])); const i = new Map(norm(intended).map((x) => [x.item_id, x]));
  const missing = [...i.keys()].filter((k) => !c.has(k));
  const extra = [...c.keys()].filter((k) => !i.has(k));
  const wrong = [...i.keys()].filter((k) => c.has(k) && JSON.stringify(c.get(k)) !== JSON.stringify(i.get(k))).map((k) => `${k}: committed ${JSON.stringify(c.get(k))} vs intended ${JSON.stringify(i.get(k))}`);
  return { equal: !missing.length && !extra.length && !wrong.length, missing, extra, wrong };
}
export const intendedTotalCents = (i: IntendedItem[]) => computeTotalCents(i);

// ---------------------------------------------------------------- results and FIXED criteria
export interface CallOutcome { tool: string; args: unknown; verdict: 'ALLOW' | 'HOLD'; code: string | null; status: string; waited_ms: number | null; content_matches_intent: boolean | null }
export interface RunResult {
  name: string; speaker: string; kind: RecordingKind; noise: string | null; duration_ms: number;
  calls: CallOutcome[];
  final_order: OrderLineLite[]; final_status: 'open' | 'confirmed' | 'cancelled';
  order_diff: OrderDiff;
  evidence_matches_intent: boolean;        // extractor over the independent finals reproduces the intended items/quantities/modifiers
  evidence_transcripts: string[];
  local_speech_runs: number; stalls: number; pending_evidence_holds: number;
  reconciliation_findings: number | null;
  ingest_errors: number;
}

/**
 * PASS CRITERIA: fixed 2026-09-20, BEFORE any real-speech run. Do not edit after results exist; a change requires a new
 * DECISIONS entry that says why, and the old thresholds stay recorded next to the new ones.
 */
export const CRITERIA = {
  minSpeakers: 3, minRecordingsPerSpeaker: 10, minNoiseRecordings: 3,
  maxConfirmedWrongOrders: 0,          // P1: zero tolerance: a confirmed order that differs from the intent reaches the kitchen
  maxFalseHoldRate: 0.15,              // P3: valid calls held / valid calls, overall AND for confirm_order separately (D-22)
  minEvidenceAccuracyClean: 0.95,      // P4: clean-room recordings
  maxEvidenceWaitMs: 4000,             // P5
  maxStallRateClean: 0.05,             // P6: clean-room recordings with a local-speech stall (independent stream never acknowledged)
} as const;

export interface CriterionResult { id: string; description: string; pass: boolean; detail: string }
export interface Evaluation { pass: boolean; criteria: CriterionResult[]; counts: Record<string, number> }

export function evaluate(runs: RunResult[]): Evaluation {
  const c = CRITERIA;
  const clean = runs.filter((r) => r.kind !== 'noise' && !r.noise);
  const speakers = new Map<string, RunResult[]>();
  for (const r of runs) speakers.set(r.speaker, [...(speakers.get(r.speaker) ?? []), r]);
  const validCalls = runs.flatMap((r) => r.calls.filter((k) => k.content_matches_intent === true));
  const heldValid = validCalls.filter((k) => k.verdict === 'HOLD');
  const validConfirm = validCalls.filter((k) => k.tool === 'confirm_order');
  const heldConfirm = validConfirm.filter((k) => k.verdict === 'HOLD');
  const rate = (a: number, b: number) => (b === 0 ? 0 : a / b);
  const confirmedWrong = runs.filter((r) => r.final_status === 'confirmed' && !r.order_diff.equal);
  const evidenceOk = clean.filter((r) => r.evidence_matches_intent).length;
  const maxWait = Math.max(0, ...runs.flatMap((r) => r.calls.map((k) => k.waited_ms ?? 0)));
  const cleanStalls = clean.filter((r) => r.stalls > 0).length;

  const coverageOk = speakers.size >= c.minSpeakers && [...speakers.values()].every((rs) => rs.length >= c.minRecordingsPerSpeaker
    && rs.some((r) => r.kind === 'imperfect_correction') && rs.some((r) => r.kind === 'overlapping_correction')) && runs.filter((r) => r.kind === 'noise' || r.noise).length >= c.minNoiseRecordings;

  const criteria: CriterionResult[] = [
    { id: 'P1', description: `0 confirmed orders that differ from the speaker's intent`, pass: confirmedWrong.length <= c.maxConfirmedWrongOrders, detail: `${confirmedWrong.length} confirmed wrong: ${confirmedWrong.map((r) => r.name).join(', ') || 'none'}` },
    { id: 'P3', description: `false-hold rate on valid calls <= ${c.maxFalseHoldRate * 100}% overall`, pass: rate(heldValid.length, validCalls.length) <= c.maxFalseHoldRate, detail: `${heldValid.length}/${validCalls.length} = ${(rate(heldValid.length, validCalls.length) * 100).toFixed(1)}%` },
    { id: 'P3b', description: `false-hold rate on valid confirm_order calls <= ${c.maxFalseHoldRate * 100}% (D-22 trade-off, reported separately)`, pass: rate(heldConfirm.length, validConfirm.length) <= c.maxFalseHoldRate, detail: `${heldConfirm.length}/${validConfirm.length} = ${(rate(heldConfirm.length, validConfirm.length) * 100).toFixed(1)}%` },
    { id: 'P4', description: `independent-stream evidence reproduces the intent in >= ${c.minEvidenceAccuracyClean * 100}% of clean-room recordings`, pass: rate(evidenceOk, clean.length) >= c.minEvidenceAccuracyClean, detail: `${evidenceOk}/${clean.length} = ${(rate(evidenceOk, clean.length) * 100).toFixed(1)}%` },
    { id: 'P5', description: `every evidence wait <= ${c.maxEvidenceWaitMs} ms`, pass: maxWait <= c.maxEvidenceWaitMs, detail: `max ${Math.round(maxWait)} ms; PENDING_EVIDENCE holds: ${runs.reduce((n, r) => n + r.pending_evidence_holds, 0)}` },
    { id: 'P6', description: `local-speech stalls in <= ${c.maxStallRateClean * 100}% of clean-room recordings`, pass: rate(cleanStalls, clean.length) <= c.maxStallRateClean, detail: `${cleanStalls}/${clean.length}` },
    { id: 'P7', description: `coverage: >= ${c.minSpeakers} speakers x >= ${c.minRecordingsPerSpeaker} recordings each, each with an imperfect AND an overlapping correction, plus >= ${c.minNoiseRecordings} noisy recordings`, pass: coverageOk, detail: `${speakers.size} speakers; recordings per speaker: ${[...speakers].map(([s, rs]) => `${s}=${rs.length}`).join(', ')}; noisy ${runs.filter((r) => r.kind === 'noise' || r.noise).length}` },
  ];
  return { pass: criteria.every((x) => x.pass), criteria, counts: { runs: runs.length, valid_calls: validCalls.length, held_valid: heldValid.length, confirmed_wrong: confirmedWrong.length, ingest_errors: runs.reduce((n, r) => n + r.ingest_errors, 0) } };
}
