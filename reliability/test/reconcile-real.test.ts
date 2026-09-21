// Option C pinned to REAL spike captures (fixtures/aai-events-A-hold): live stream + independent STT + stored timeline.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { reconcileTimeline } from '../src/reconcile.js';

const DIR = 'fixtures/aai-events-A-hold';
const read = (f: string) => readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

function load(name: string) {
  const primary = read(`${DIR}/${name}.jsonl`);
  const stt = read(`${DIR}/${name}.stt.jsonl`);
  const tl = JSON.parse(readFileSync(`${DIR}/${name}.timeline.json`, 'utf8'));
  return {
    live: primary.filter((l: any) => l.dir === 'in' && l.msg?.type === 'transcript.user').map((l: any) => l.msg.text as string),
    independent: stt.filter((r: any) => r.dir === 'in' && r.msg?.type === 'Turn' && r.msg.end_of_turn).map((r: any) => r.msg.transcript as string),
    turns: tl.turns,
  };
}
const have = existsSync(`${DIR}/late_correction_900ms-1.timeline.json`);
const opts = { minConfidence: 0.8 };

describe.skipIf(!have)('reconcile on real captures', () => {
  it('spike-g5 failure (correction never on the live stream) is detected as LIVE_TRANSCRIPT_MISSING only; independent stream is fine', () => {
    for (const n of ['late_correction_900ms-1', 'late_correction_1500ms-1', 'correction_during_hold-1', 'barge_in-1']) {
      const codes = reconcileTimeline(load(n), opts).map((f) => f.code);
      expect(codes, n).toEqual(['LIVE_TRANSCRIPT_MISSING']);
    }
  });
  it('a clean run and an inline-correction run produce no findings', () => {
    for (const n of ['clean_order-1', 'inline_correction-1']) expect(reconcileTimeline(load(n), opts), n).toEqual([]);
  });
  it('no false positives when the timeline merged two utterances the streams delivered separately (late_400 runs)', () => {
    for (const n of ['late_correction_400ms-1', 'late_correction_400ms-2', 'late_correction_400ms-3', 'late_correction_900ms-3']) {
      expect(reconcileTimeline(load(n), opts), n).toEqual([]);
    }
  });
  it('every stale-first-call run in the capture set is caught, and nothing else is', () => {
    const stale = ['barge_in-1', 'barge_in-2', 'barge_in-3', 'correction_during_hold-1', 'correction_during_hold-2', 'correction_during_hold-3', 'late_correction_1500ms-1', 'late_correction_1500ms-2', 'late_correction_1500ms-3', 'late_correction_900ms-1', 'late_correction_900ms-2'];
    for (const n of stale) expect(reconcileTimeline(load(n), opts).map((f) => f.code), n).toEqual(['LIVE_TRANSCRIPT_MISSING']);
  });
  it('stored user_confidence is constant 1 in this sample, so LOW_TIMELINE_CONFIDENCE never fires (documented, not assumed useful)', () => {
    const all = ['clean_order-1', 'barge_in-1', 'late_correction_900ms-1'].flatMap((n) => load(n).turns.map((t: any) => t.user_confidence).filter((c: unknown) => c !== null));
    expect(new Set(all)).toEqual(new Set([1]));
  });
});
