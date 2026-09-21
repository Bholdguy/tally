import { describe, expect, it } from 'vitest';
import { normaliseUtterance, reconcileTimeline } from '../src/reconcile.js';

const opts = { minConfidence: 0.8 };
const turn = (t: string | null, c: number | null = 1) => ({ user_transcript: t, user_confidence: c });

describe('normaliseUtterance', () => {
  it('lowercases, strips punctuation and maps number words to digits', () => {
    expect(normaliseUtterance('No, wait, make it THREE!')).toBe('no wait make it 3');
    expect(normaliseUtterance('No, wait, make it 3.')).toBe('no wait make it 3');
  });
});

describe('reconcileTimeline (option C safety net)', () => {
  it('no findings when live and independent streams both match the stored timeline', () => {
    const f = reconcileTimeline({ live: ['2 burgers.', 'No, wait, make it 3.'], independent: ['2 burgers.', 'No, wait, make it three.'], turns: [turn('2 burgers.'), turn('No, wait, make it 3.')] }, opts);
    expect(f).toEqual([]);
  });

  it('the spike-g5 failure: correction in the stored timeline but never on the live stream', () => {
    const f = reconcileTimeline({ live: ['2 burgers.'], independent: ['2 burgers.', 'No, wait, make it 3.'], turns: [turn('2 burgers.'), turn('No, wait, make it 3.')] }, opts);
    expect(f.map((x) => x.code)).toEqual(['LIVE_TRANSCRIPT_MISSING']);
    expect(f[0]!.timeline_text).toBe('No, wait, make it 3.');
  });

  it('independent stream ALSO missing it is reported separately (option A itself failed)', () => {
    const f = reconcileTimeline({ live: ['2 burgers.'], independent: ['2 burgers.'], turns: [turn('2 burgers.'), turn('No, wait, make it 3.')] }, opts);
    expect(f.map((x) => x.code).sort()).toEqual(['INDEPENDENT_TRANSCRIPT_MISSING', 'LIVE_TRANSCRIPT_MISSING']);
  });

  it('independent stream that heard a different number is flagged as a disagreement', () => {
    const f = reconcileTimeline({ live: ['make it 3'], independent: ['make it 2'], turns: [turn('make it 3')] }, opts);
    expect(f.map((x) => x.code)).toEqual(['INDEPENDENT_DISAGREES']);
  });

  it('low stored confidence is flagged using user_confidence', () => {
    const f = reconcileTimeline({ live: ['2 burgers.'], independent: ['2 burgers.'], turns: [turn('2 burgers.', 0.42)] }, opts);
    expect(f.map((x) => x.code)).toEqual(['LOW_TIMELINE_CONFIDENCE']);
    expect(f[0]!.user_confidence).toBe(0.42);
  });

  it('null confidence (field absent) is not treated as low, and turns without user speech are skipped', () => {
    const f = reconcileTimeline({ live: [], independent: [], turns: [turn(null), turn('   ', null)] }, opts);
    expect(f).toEqual([]);
    expect(reconcileTimeline({ live: ['hi'], independent: ['hi'], turns: [turn('hi', null)] }, opts)).toEqual([]);
  });

  it('tolerates streams that merge or split utterances (containment, not equality)', () => {
    const f = reconcileTimeline({ live: ['2 burgers. No, wait, make it 3.'], independent: ['2 burgers. No, wait, make it 3.'], turns: [turn('2 burgers.'), turn('No, wait, make it 3.')] }, opts);
    expect(f).toEqual([]);
  });

  it('deterministic: same input twice gives identical findings', () => {
    const input = { live: ['2 burgers.'], independent: [] as string[], turns: [turn('2 burgers.'), turn('No, wait, make it 3.', 0.5)] };
    expect(JSON.stringify(reconcileTimeline(input, opts))).toBe(JSON.stringify(reconcileTimeline(input, opts)));
  });
});
