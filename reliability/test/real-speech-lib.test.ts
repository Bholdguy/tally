import { describe, expect, it } from 'vitest';
import { CRITERIA, diffOrder, estimateNoiseFloor, evaluate, parseWav, sameOrder, toPcm24k, type RunResult } from '../../scripts/lib/real-speech.js';

function wav(samples: number[], rate: number, channels = 1, bits = 16, format = 1, extraChunk = false): Uint8Array {
  const data = new Uint8Array(samples.length * 2); const dd = new DataView(data.buffer);
  samples.forEach((s, i) => dd.setInt16(i * 2, s, true));
  const fmt = new Uint8Array(24); const fd = new DataView(fmt.buffer);
  [...'fmt '].forEach((c, i) => fd.setUint8(i, c.charCodeAt(0))); fd.setUint32(4, 16, true); fd.setUint16(8, format, true); fd.setUint16(10, channels, true);
  fd.setUint32(12, rate, true); fd.setUint32(16, rate * channels * 2, true); fd.setUint16(20, channels * 2, true); fd.setUint16(22, bits, true);
  const list = extraChunk ? new Uint8Array([...'LIST'].map((c) => c.charCodeAt(0)).concat([4, 0, 0, 0, 1, 2, 3, 4])) : new Uint8Array(0);
  const head = new Uint8Array(12); const hd = new DataView(head.buffer);
  [...'RIFF'].forEach((c, i) => hd.setUint8(i, c.charCodeAt(0))); [...'WAVE'].forEach((c, i) => hd.setUint8(8 + i, c.charCodeAt(0)));
  const dh = new Uint8Array(8); [...'data'].forEach((c, i) => (dh[i] = c.charCodeAt(0))); new DataView(dh.buffer).setUint32(4, data.length, true);
  const out = new Uint8Array(head.length + fmt.length + list.length + dh.length + data.length);
  let o = 0; for (const p of [head, fmt, list, dh, data]) { out.set(p, o); o += p.length; }
  return out;
}

describe('WAV loading', () => {
  it('reads mono 16-bit PCM, including past extra chunks', () => {
    expect(Array.from(parseWav(wav([1, -2, 3], 24000, 1, 16, 1, true)).pcm16)).toEqual([1, -2, 3]);
  });
  it('rejects non-16-bit / non-PCM with a message telling the user how to convert', () => {
    expect(() => parseWav(wav([1, 2], 24000, 1, 8))).toThrow(/16-bit PCM/);
    expect(() => parseWav(wav([1, 2], 24000, 1, 16, 3))).toThrow(/ffmpeg/);
    expect(() => parseWav(new Uint8Array(10))).toThrow(/RIFF/);
  });
  it('downmixes stereo to mono', () => {
    const out = toPcm24k(parseWav(wav([100, 300, 200, 400], 24000, 2)));
    const dv = new DataView(out.buffer);
    expect([dv.getInt16(0, true), dv.getInt16(2, true)]).toEqual([200, 300]);
  });
  it('resamples 16 kHz -> 24 kHz (length x1.5) and keeps a DC level intact', () => {
    const out = toPcm24k(parseWav(wav(new Array(1600).fill(1000), 16000)));
    expect(out.byteLength / 2).toBe(2400);
    const dv = new DataView(out.buffer);
    expect(dv.getInt16(200, true)).toBe(1000);
  });
  it('48 kHz -> 24 kHz halves the length', () => {
    expect(toPcm24k(parseWav(wav(new Array(4800).fill(5), 48000))).byteLength / 2).toBe(2400);
  });
  it('estimates the room-noise floor from the leading silence', () => {
    const pcm = new Uint8Array(24000 * 2); const dv = new DataView(pcm.buffer);
    for (let i = 0; i < 12000; i++) dv.setInt16(i * 2, i % 2 ? 200 : -200, true);
    expect(estimateNoiseFloor(pcm, 500)).toBeCloseTo(200, 0);
    expect(estimateNoiseFloor(new Uint8Array(0))).toBe(0);
  });
});

describe('order comparison against the speaker\'s written intent', () => {
  const b = (q: number, m: string[] = []) => ({ item_id: 'burger', quantity: q, modifiers: m });
  it('equal regardless of modifier order and line order', () => {
    expect(sameOrder([{ item_id: 'coke', quantity: 1, modifiers: [] }, b(2, ['no_onions', 'extra_cheese'])], [b(2, ['extra_cheese', 'no_onions']), { item_id: 'coke', quantity: 1, modifiers: [] }])).toBe(true);
  });
  it('reports missing, extra and wrong lines separately', () => {
    const d = diffOrder([b(2), { item_id: 'fries', quantity: 1, modifiers: [] }], [b(3), { item_id: 'coke', quantity: 1, modifiers: [] }]);
    expect(d.equal).toBe(false);
    expect(d.missing).toEqual(['coke']);
    expect(d.extra).toEqual(['fries']);
    expect(d.wrong[0]).toContain('burger');
  });
});

describe('FIXED pass criteria', () => {
  const run = (over: Partial<RunResult> = {}): RunResult => ({
    name: 'r', speaker: 'A', kind: 'clean', noise: null, duration_ms: 10000,
    calls: [{ tool: 'add_item', args: {}, verdict: 'ALLOW', code: null, status: 'allowed', waited_ms: 0, content_matches_intent: true }, { tool: 'confirm_order', args: {}, verdict: 'ALLOW', code: null, status: 'allowed', waited_ms: 0, content_matches_intent: true }],
    final_order: [], final_status: 'confirmed', order_diff: { equal: true, missing: [], extra: [], wrong: [] }, evidence_matches_intent: true, evidence_transcripts: [],
    local_speech_runs: 1, stalls: 0, pending_evidence_holds: 0, reconciliation_findings: 0, ingest_errors: 0, ...over,
  });
  const cohort = (): RunResult[] => ['A', 'B', 'C'].flatMap((sp) => Array.from({ length: 10 }, (_, i) => run({
    name: `${sp}${i}`, speaker: sp, kind: i === 0 ? 'imperfect_correction' : i === 1 ? 'overlapping_correction' : i === 2 && sp !== 'C' ? 'noise' : i === 3 && sp === 'C' ? 'noise' : 'clean', noise: i === 2 || (i === 3 && sp === 'C') ? 'tv' : null,
  })));

  it('the thresholds are the ones written down in advance', () => {
    expect(CRITERIA).toMatchObject({ maxConfirmedWrongOrders: 0, maxFalseHoldRate: 0.15, minEvidenceAccuracyClean: 0.95, maxEvidenceWaitMs: 4000, maxStallRateClean: 0.05, minSpeakers: 3, minRecordingsPerSpeaker: 10 });
  });
  it('a clean, complete cohort passes every criterion', () => {
    const e = evaluate(cohort());
    expect(e.criteria.filter((c) => !c.pass), JSON.stringify(e.criteria)).toEqual([]);
    expect(e.pass).toBe(true);
  });
  it('P1 has ZERO tolerance: one confirmed order that differs from the intent fails the pass', () => {
    const runs = cohort(); runs[5] = run({ name: 'bad', speaker: 'A', order_diff: { equal: false, missing: [], extra: [], wrong: ['burger: 2 vs 3'] } });
    const e = evaluate(runs);
    expect(e.pass).toBe(false);
    expect(e.criteria.find((c) => c.id === 'P1')).toMatchObject({ pass: false });
  });
  it('a wrong order that was NOT confirmed does not trip P1 (the gate held it), but is still counted', () => {
    const runs = cohort(); runs[5] = run({ final_status: 'open', order_diff: { equal: false, missing: [], extra: [], wrong: ['x'] } });
    expect(evaluate(runs).criteria.find((c) => c.id === 'P1')!.pass).toBe(true);
  });
  it('P3 false holds are measured on VALID calls only and confirm_order is reported separately', () => {
    const runs = cohort();
    for (let i = 0; i < 12; i++) runs[i] = run({ ...runs[i], calls: [{ tool: 'confirm_order', args: {}, verdict: 'HOLD', code: 'QTY_MISMATCH', status: 'conflict', waited_ms: 0, content_matches_intent: true }] });
    const e = evaluate(runs);
    expect(e.criteria.find((c) => c.id === 'P3b')!.pass).toBe(false);
  });
  it('a hold on a call whose content did NOT match the intent is a true positive, not a false hold', () => {
    const runs = cohort(); runs[0] = run({ ...runs[0], calls: [{ tool: 'add_item', args: {}, verdict: 'HOLD', code: 'QTY_MISMATCH', status: 'conflict', waited_ms: 900, content_matches_intent: false }] });
    expect(evaluate(runs).criteria.find((c) => c.id === 'P3')!.pass).toBe(true);
  });
  it('P5: any wait over 4000 ms fails; P4/P6 measured on clean-room only', () => {
    const runs = cohort(); runs[6] = run({ ...runs[6], calls: [{ tool: 'add_item', args: {}, verdict: 'HOLD', code: 'PENDING_EVIDENCE', status: 'held', waited_ms: 4100, content_matches_intent: true }] });
    expect(evaluate(runs).criteria.find((c) => c.id === 'P5')!.pass).toBe(false);
    const noisy = cohort().map((r) => (r.noise ? { ...r, evidence_matches_intent: false, stalls: 2 } : r));
    const e = evaluate(noisy);
    expect(e.criteria.find((c) => c.id === 'P4')!.pass).toBe(true);   // noisy recordings are excluded from the clean-room accuracy criterion
    expect(e.criteria.find((c) => c.id === 'P6')!.pass).toBe(true);
  });
  it('P7 coverage: too few speakers / recordings / no overlapping correction fails, however good the results', () => {
    expect(evaluate(cohort().slice(0, 20)).criteria.find((c) => c.id === 'P7')!.pass).toBe(false);
    const noOverlap = cohort().map((r) => (r.kind === 'overlapping_correction' ? { ...r, kind: 'clean' as const } : r));
    expect(evaluate(noOverlap).criteria.find((c) => c.id === 'P7')!.pass).toBe(false);
  });
});
