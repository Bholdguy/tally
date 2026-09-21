/**
 * Post-hoc reconciliation (option C, DECISIONS D-19): a PERMANENT safety net layered on top of the independent STT
 * stream (option A), never a replacement for it. It compares what the customer said, as recorded by AssemblyAI's
 * stored session timeline, against what Tally saw live, and reports gaps. Detection, not prevention: findings feed
 * RECORD FAILURE (cases) and metrics. Pure function: the network fetch lives in /stt.
 */
export interface TimelineTurn {
  user_transcript: string | null;
  user_confidence: number | null;
  user_speech_started_at_ms?: number | null;
  user_speech_ended_at_ms?: number | null;
}

export type ReconcileCode =
  | 'LIVE_TRANSCRIPT_MISSING'        // the timeline has a customer utterance the Voice Agent live stream never delivered (F2)
  | 'INDEPENDENT_TRANSCRIPT_MISSING' // the timeline has an utterance Tally's own STT stream never produced (option A gap)
  | 'INDEPENDENT_DISAGREES'          // independent stream heard something materially different from the timeline
  | 'LOW_TIMELINE_CONFIDENCE';       // the stored transcript itself is low-confidence

export interface ReconcileFinding {
  code: ReconcileCode;
  timeline_text: string;
  matched_text?: string;
  user_confidence: number | null;
  detail: string;
}

export interface ReconcileInput {
  live: readonly string[];        // finalised transcript.user texts from the Voice Agent live stream
  independent: readonly string[]; // finalised turns from Tally's own STT stream
  turns: readonly TimelineTurn[];
}
export interface ReconcileOptions { minConfidence: number }

const NUM: Record<string, string> = { zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10' };

/** Lowercase, strip punctuation, map number words to digits, collapse whitespace. Deterministic. */
export function normaliseUtterance(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean).map((w) => NUM[w] ?? w).join(' ');
}

const isDigit = (w: string) => /^\d+$/.test(w);
const words = (s: string) => normaliseUtterance(s).split(' ').filter((w) => w && !isDigit(w));
const digitSet = (s: string) => new Set(normaliseUtterance(s).split(' ').filter(isDigit));

/**
 * Word coverage: fraction of the timeline utterance's NON-numeric words present in the candidate. Numbers are compared
 * separately (digitsContained) so "make it 3" vs "make it 2" reads as a DISAGREEMENT, not as a missing transcript.
 * Streams may merge or split turns, so this is containment, not equality.
 */
function wordCoverage(timeline: string, candidate: string): number {
  const t = new Set(words(timeline));
  if (t.size === 0) return 1;
  const c = new Set(words(candidate));
  let hit = 0;
  for (const w of t) if (c.has(w)) hit++;
  return hit / t.size;
}

/** Every number in the timeline utterance must appear in the candidate (extra numbers from a merged turn are fine). */
function digitsContained(timeline: string, candidate: string): boolean {
  const c = digitSet(candidate);
  for (const d of digitSet(timeline)) if (!c.has(d)) return false;
  return true;
}

function bestMatch(text: string, pool: readonly string[]): { text: string; cov: number } | undefined {
  let best: { text: string; cov: number } | undefined;
  // Streams segment speech differently: the stored timeline sometimes merges two utterances that a live stream delivered
  // as two turns (seen in real captures). So also try the whole pool concatenated in order.
  const candidates = pool.length > 1 ? [...pool, pool.join(' ')] : pool;
  for (const cand of candidates) {
    // rank by word coverage, prefer candidates whose numbers also match
    const cov = wordCoverage(text, cand) + (digitsContained(text, cand) ? 0.001 : 0);
    if (!best || cov > best.cov) best = { text: cand, cov };
  }
  return best;
}

const MATCH_COVERAGE = 0.8;

export function reconcileTimeline(input: ReconcileInput, opts: ReconcileOptions): ReconcileFinding[] {
  const out: ReconcileFinding[] = [];
  for (const turn of input.turns) {
    const text = turn.user_transcript?.trim();
    if (!text) continue;
    const conf = turn.user_confidence ?? null;

    if (conf !== null && conf < opts.minConfidence) {
      out.push({ code: 'LOW_TIMELINE_CONFIDENCE', timeline_text: text, user_confidence: conf, detail: `stored user_confidence ${conf} < ${opts.minConfidence}` });
    }
    const live = bestMatch(text, input.live);
    if (!live || live.cov < MATCH_COVERAGE || !digitsContained(text, live.text)) {
      out.push({ code: 'LIVE_TRANSCRIPT_MISSING', timeline_text: text, matched_text: live?.text, user_confidence: conf, detail: 'customer utterance in the stored timeline was never delivered (or was delivered with different numbers) on the live stream' });
    }
    const ind = bestMatch(text, input.independent);
    if (!ind || ind.cov < MATCH_COVERAGE) {
      out.push({ code: 'INDEPENDENT_TRANSCRIPT_MISSING', timeline_text: text, matched_text: ind?.text, user_confidence: conf, detail: ind ? `best independent match covers only ${(Math.min(1, ind.cov) * 100).toFixed(0)}% of the stored utterance's words` : 'independent STT stream produced no transcript at all for this call' });
    } else if (!digitsContained(text, ind.text)) {
      out.push({ code: 'INDEPENDENT_DISAGREES', timeline_text: text, matched_text: ind.text, user_confidence: conf, detail: 'numbers in the stored timeline are not present in the independent stream' });
    }
  }
  return out;
}
