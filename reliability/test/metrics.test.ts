// Step 12: every metric is recomputed from the raw rows, independently, and compared. Latency is client-observed.
import { describe, expect, it, vi } from 'vitest';
import { computeMetrics, percentile, stats } from '../src/metrics.js';
import { makeRig, type Rig } from './rig.js';

const B = (q: number) => ({ item_id: 'burger', quantity: q, modifiers: [] as string[] });

/** A scripted call on the fake clock: every latency below is known by construction. */
async function scripted(): Promise<Rig> {
  const r = makeRig({ persist: true, regressionThreshold: 5 });
  r.up();
  r.localStart(); r.clock.advance(1000); r.localEnd();                         // customer speaks 0-1000
  r.clock.advance(600); r.final('A coke.');                                    // independent final at 1600  -> stt 600
  expect((await r.call('add_item', { item_id: 'coke', quantity: 1, modifiers: [] })).verdict).toBe('ALLOW');   // gate 0
  r.clock.advance(2100); r.emit({ kind: 'reply_audible' });                    // first audible agent audio at 3700 -> first_audio 2700
  r.clock.advance(1300); r.localStart();                                       // 5000
  r.clock.at(5300, () => r.speechStarted());
  r.clock.advance(1000); r.localEnd();                                         // 6000
  r.clock.at(8200, () => r.final('Two burgers, no wait, make it three.'));     // late independent final -> stt 2200
  const held = await r.call('add_item', B(2));                                 // arrives at 6000, waits until 8200 -> gate 2200
  expect(held).toMatchObject({ verdict: 'HOLD', code: 'QTY_MISMATCH' });
  r.clock.advance(800); r.localStart();                                        // 9000
  r.clock.at(9100, () => r.speechStarted());
  r.clock.advance(500); r.localEnd();                                          // 9500
  r.clock.at(9900, () => r.final('Yes, three.'));
  r.clock.advance(400);                                                        // 9900 -> stt 400
  expect((await r.call('add_item', B(3))).verdict).toBe('ALLOW');              // gate 0; resolves the repair
  r.clock.advance(600); r.emit({ kind: 'reply_audible' });                     // 10500 -> first_audio 1000
  r.store.setIntent(r.session, { items: [{ item_id: 'coke', quantity: 1 }, { item_id: 'burger', quantity: 3 }] });
  r.store.endSession(r.session);
  return r;
}

describe('percentiles (nearest rank)', () => {
  it('p50/p95 are actual sample values; empty sample has no numbers; single value', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 95)).toBe(4);
    expect(percentile([5, 1, 3], 50)).toBe(3);
    const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(twenty, 95)).toBe(19);
    expect(percentile(twenty, 50)).toBe(10);
    expect(stats([2, 4, 6])).toEqual({ n: 3, p50: 4, p95: 6, max: 6, mean: 4 });
  });
});

describe('metrics are computed from stored rows and match the known timeline', () => {
  it('per-stage latency: stt, gate, first_audio (by construction), commit and repair (from the rows)', async () => {
    const r = await scripted();
    const m = computeMetrics(r.store);
    expect(m).toMatchObject({ generated_from: 'stored rows', latency_basis: 'client-observed' });
    expect(m.stages.stt).toEqual({ n: 3, p50: 600, p95: 2200, max: 2200, mean: (600 + 2200 + 400) / 3 });
    expect(m.stages.gate).toEqual({ n: 3, p50: 0, p95: 2200, max: 2200, mean: 2200 / 3 });
    expect(m.stages.first_audio).toEqual({ n: 2, p50: 1000, p95: 2700, max: 2700, mean: 1850 });
    const commits = (r.store.r.prepare("SELECT t_commit_ms v FROM tool_calls WHERE status='allowed'").all() as { v: number }[]).map((x) => x.v);
    expect(m.stages.commit.n).toBe(2);
    expect(m.stages.commit.max).toBe(Math.max(...commits));
    const rep = r.store.r.prepare("SELECT (r.resolved_at - t.timestamp) d FROM repair_events r JOIN tool_calls t ON t.id=r.tool_call_id WHERE r.outcome='resolved'").all() as { d: number }[];
    expect(rep).toHaveLength(1);
    expect(m.stages.repair).toMatchObject({ n: 1, p50: rep[0]!.d });
    expect(m.stages.barge_in.n).toBe(0);
    r.close();
  });

  it('counts and rates match the rows: conflict 1/3, repair success 1/1, no false positive, no regressions yet, accuracy 1/1 (declared intent)', async () => {
    const r = await scripted();
    const m = computeMetrics(r.store);
    expect(m.counts).toMatchObject({ gated_calls: 3, allowed: 2, held_or_conflict: 1, cases: 1, regressions: 0, sessions: 1, ended_sessions: 1 });
    expect(m.rates.conflict_rate).toEqual({ value: 1 / 3, n: 1, of: 3 });
    expect(m.rates.repair_success_rate).toEqual({ value: 1, n: 1, of: 1 });
    expect(m.rates.false_positive_rate).toMatchObject({ value: 0, n: 0, of: 1 });
    expect(m.rates.regression_pass_rate).toEqual({ value: null, n: 0, of: 0 });
    expect(m.rates.final_order_accuracy).toMatchObject({ value: 1, n: 1, of: 1 });
    expect(m.rates.final_order_accuracy.note).toMatch(/declared intent/);
    r.close();
  });

  it('a WRONG declared intent lowers accuracy (measured, not assumed); sessions without an intent are not counted', async () => {
    const r = await scripted();
    const r2 = makeRig({ persist: true, sharedStore: r.store, sharedPath: r.path, session: 's2' });
    r2.store.setIntent('s2', { items: [{ item_id: 'burger', quantity: 9 }] });
    r2.store.endSession('s2');
    const r3 = makeRig({ persist: true, sharedStore: r.store, sharedPath: r.path, session: 's3' });
    r3.store.endSession('s3');
    expect(computeMetrics(r.store).rates.final_order_accuracy).toMatchObject({ value: 0.5, n: 1, of: 2 });
    r.close();
  });

  it('false positives are counted when a HELD call was actually correct (judged by the validated expected state)', async () => {
    const r = makeRig({ persist: true });
    r.up(); r.final('two burgers.', { conf: 0.4 });
    expect(await r.call('add_item', B(2))).toMatchObject({ verdict: 'HOLD', code: 'UNVALIDATABLE' });
    r.clock.advance(400); r.final('two burgers.', { conf: 0.9 });
    expect((await r.call('add_item', B(2))).verdict).toBe('ALLOW');
    const m = computeMetrics(r.store);
    expect(m.rates.false_positive_rate).toMatchObject({ n: 1, of: 1, value: 1 });
    r.close();
  });

  it('a deliberately slow commit raises the commit stage (the number comes from the stored row)', async () => {
    const r = makeRig({ persist: true });
    r.up(); r.final('a coke.');
    const now = vi.spyOn(performance, 'now');
    let t = 0; now.mockImplementation(() => (t += 800));
    await r.call('add_item', { item_id: 'coke', quantity: 1, modifiers: [] });
    now.mockRestore();
    const m = computeMetrics(r.store);
    expect(m.stages.commit.n).toBe(1);
    expect(m.stages.commit.p95).toBeGreaterThanOrEqual(800);
    r.close();
  });
});
