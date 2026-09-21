// STEP 15: deterministic demo mode. Prerecorded audio through the REAL pipeline; scripted agent and transcripts. Run twice from a fresh DB =>
// identical verdicts, orders, cases and counters; every experience ends with the order the (declared) intent says.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initDatabase } from '@tally/db';
import { Store } from '@tally/reliability';
import { normalise, runAll, runScenario, type ScenarioName, type ScenarioResult } from '../src/demo/scenarios.js';

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'tally-demo-'));
  initDatabase(join(dir, 'd.sqlite'));
  return { store: new Store(join(dir, 'd.sqlite')), audioDir: join(dir, 'audio') };
};
const canon = (l: { item_id: string; quantity: number; modifiers?: readonly string[] }[]) => JSON.stringify([...l].map((x) => ({ i: x.item_id, q: x.quantity, m: [...(x.modifiers ?? [])].sort() })).sort((a, b) => (a.i < b.i ? -1 : 1)));

async function play(names: readonly ScenarioName[]): Promise<{ results: ScenarioResult[]; text: string; store: Store }> {
  const w = fresh();
  const results = await runAll({ store: w.store, audioDir: w.audioDir }, names);
  return { results, text: normalise(results), store: w.store };
}

describe('the demo clips are checked in and pinned', () => {
  it('every clip is a 24 kHz mono PCM16 WAV and its hash is pinned (a re-synthesised clip must be a deliberate, reviewed change)', () => {
    const dir = new URL('../../demo/clips/', import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith('.wav')).sort();
    expect(files).toEqual(['clean.wav', 'inline_corr.wav', 'no_wait_three.wav', 'no_wait_three_b.wav', 'pickup_asap.wav', 'two_burgers.wav', 'yes_three.wav']);
    const sums = files.map((f) => `${f}:${createHash('sha256').update(readFileSync(new URL(f, dir))).digest('hex').slice(0, 16)}`);
    const dv = (f: string) => new DataView(new Uint8Array(readFileSync(new URL(f, dir))).buffer);
    for (const f of files) { const v = dv(f); expect(v.getUint32(24, true)).toBe(24000); expect(v.getUint16(22, true)).toBe(1); expect(v.getUint16(34, true)).toBe(16); }
    const pinned = readFileSync(new URL('CLIPS.sha256', dir), 'utf8').trim().split('\n');
    expect(sums).toEqual(pinned);
  });
});

describe('scenarios A, B, confidence, dropout: identical on every run, ending in the intended order', () => {
  it('two runs from a fresh DB produce byte-identical normalised output', async () => {
    const names: ScenarioName[] = ['A', 'B', 'confidence', 'dropout'];
    const one = await play(names);
    const two = await play(names);
    expect(two.text).toBe(one.text);
    const [A, B, conf, drop] = one.results;

    // A: clean. Three ALLOWs, nothing held, no case; 2x burger + coke = $20.47, confirmed
    expect(A!.sessions[0]!.verdicts.map((v) => `${v.verdict}:${v.tool}`)).toEqual(['ALLOW:add_item', 'ALLOW:add_item', 'ALLOW:confirm_order']);
    expect(A!.sessions[0]!.final_order).toMatchObject({ total_cents: 2047, status: 'confirmed' });
    expect(A!.counters.cases).toBe(0);

    // B: the gate WAITED, held the stale call, asked the scoped question, and the repaired call landed; a barge-in was derived
    const b = B!.sessions[0]!;
    expect(b.verdicts).toEqual([
      expect.objectContaining({ verdict: 'HOLD', code: 'QTY_MISMATCH', waited: true }),
      expect.objectContaining({ verdict: 'ALLOW', repaired: true }),
    ]);
    expect(b.repairs).toEqual(["asked: Just to confirm, that's 3 classic burgers?"]);
    expect(b.barge_ins).toBe(1);
    expect(b.final_order).toMatchObject({ total_cents: 2697 });
    expect(b.cases).toEqual([expect.objectContaining({ pattern_key: 'QTY_MISMATCH|add_item|correction|after_item', resolution: 'resolved' })]);

    // confidence: a misheard quantity is held (never confirmed on low confidence), then re-validated
    expect(conf!.sessions[0]!.verdicts.map((v) => `${v.verdict}:${v.code ?? ''}`)).toEqual(['HOLD:UNVALIDATABLE', 'ALLOW:']);
    // dropout: the evidence stream dies while the gate waits: HELD (fail closed), nothing committed
    expect(drop!.sessions[0]!.verdicts).toEqual([expect.objectContaining({ verdict: 'HOLD', code: 'UNVALIDATABLE' })]);
    expect(drop!.sessions[0]!.final_order!.lines).toEqual([]);

    // every session ends in the order it was DECLARED to intend (the declared intent is the ground truth: never derived from the run)
    for (const r of [A!, B!, conf!, drop!]) for (const s of r.sessions) expect(canon(s.final_order!.lines as never), r.label).toBe(canon(s.intent.items));
    // and the accuracy metric, computed from the stored rows, agrees
    const { computeMetrics } = await import('@tally/reliability');
    expect(computeMetrics(one.store).rates.final_order_accuracy).toMatchObject({ n: 4, of: 4 });   // dropout intended nothing and (correctly) committed nothing
  }, 240000);
});

describe('scenarios D and C', () => {
  it('D: the same correction three times => three real cases share one pattern; on the 3rd all become regression candidates (regression status needs the OPERATOR)', async () => {
    const { results, store } = await play(['D']);
    const cases = store.listCases();
    expect(cases).toHaveLength(3);
    expect(new Set(cases.map((c) => c.pattern_key))).toEqual(new Set(['QTY_MISMATCH|add_item|correction|mid_item']));
    expect(cases.map((c) => c.tag)).toEqual(['regression_candidate', 'regression_candidate', 'regression_candidate']);
    expect(results[0]!.counters).toEqual({ cases: 3, regression_candidates: 3, regressions: 0 });
    for (const s of results[0]!.sessions) expect(s.final_order).toMatchObject({ total_cents: 2697 });
    // the operator accepts one (never automatic, D-29): it becomes a regression
    expect(store.acceptRegression(cases[0]!.id, 'operator')).toEqual({ ok: true });
    expect(store.caseCounts()).toMatchObject({ regressions: 1, candidates: 2 });
  }, 120000);

  it('C: B\'s case replayed against v1 and v2 (evidence: deterministic PASS; audio: k/3 with the scripted agent)', async () => {
    const { results } = await play(['C']);                                                    // C plays B first when there is no case yet
    expect(results[0]!.replay).toMatchObject({ case_pattern: 'QTY_MISMATCH|add_item|correction|after_item', audio: { version: 'v2', label: '3/3 passed', k: 3, passed: 3 } });
    expect(results[0]!.replay!.evidence.map((e) => e.label)).toEqual(['PASS (deterministic)', 'PASS (deterministic)']);
    expect(JSON.stringify(results[0]!.replay)).not.toMatch(/audio.*determin/i);
  }, 120000);
});

describe('honesty', () => {
  it('every result says it is scripted and deterministic; the banner is present', async () => {
    const w = fresh();
    const r = await runScenario('dropout', { store: w.store, audioDir: w.audioDir });
    expect(r).toMatchObject({ deterministic: true, scripted: { agent: true, transcripts: true } });
    expect(r.banner).toMatch(/scripted \(not the live agent\)/);
  }, 60000);
});
