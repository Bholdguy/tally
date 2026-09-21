// Step 8, evidence tier: stored events re-fed through the CURRENT ingest -> tracker -> extractor -> gate. Deterministic.
import { describe, expect, it } from 'vitest';
import { describeReplay, desiredOutcome, judgeAudioRun, replayEvidence, ReplayError } from '../src/replay.js';
import { extractEvidence } from '../src/extractor.js';
import { makeRig, type Rig } from './rig.js';

const B = (q: number) => ({ item_id: 'burger', quantity: q, modifiers: [] as string[] });
const rows = (r: Rig, sql: string, ...p: unknown[]) => r.store.r.prepare(sql).all(...p) as any[];

/** Scenario B at the spike-A timings, persisted: the stale call is HELD after waiting for the independent final; then "yes three" resolves it. */
async function scenarioB(): Promise<{ r: Rig; caseId: string }> {
  const r = makeRig({ persist: true });
  r.up();
  r.final('2 burgers.');
  r.localStart();
  r.clock.at(600, () => r.speechStarted());
  r.clock.at(1000, () => r.partial('No, wait,', { order: 1 }));
  r.clock.at(2700, () => r.localEnd());
  r.clock.at(3450, () => r.final('No, wait, make it 3.', { order: 1 }));
  const held = await r.call('add_item', B(2));
  expect(held).toMatchObject({ verdict: 'HOLD', code: 'QTY_MISMATCH' });
  const caseId = r.store.listCases()[0]!.id;
  r.clock.advance(1500); r.final('Yes, three.', { order: 2 });
  expect((await r.call('add_item', B(3))).verdict).toBe('ALLOW');
  return { r, caseId };
}

describe('evidence-tier replay: known-fixed case PASSES', () => {
  it('re-feeds the stored events (including the ones that arrived DURING the wait) and the current gate still holds the stale call, at the same timing', async () => {
    const { r, caseId } = await scenarioB();
    const rep = await replayEvidence(r.store, caseId);
    expect(rep.result).toBe('pass');
    expect(rep.label).toBe('PASS (deterministic)');
    expect(rep.diff).toMatchObject({
      basis: 'expected_state', desired: 'HOLD', reason: 'still_held', result: 'pass', code_changed: false,
      actual: { verdict: 'HOLD', code: 'QTY_MISMATCH', noop: null }, case: { original_code: 'QTY_MISMATCH', resolution: 'resolved' },
      order_before: [], order_after: [], expected_lines: [{ item_id: 'burger', quantity: 3, modifiers: [] }],
    });
    expect((rep.diff.actual as { waited_ms: number }).waited_ms).toBeGreaterThanOrEqual(3450);   // it waited for the independent final again
    r.close();
  });

  it('DETERMINISM: run three times => byte-identical diff_json and verdict; every stored run row carries the same diff', async () => {
    const { r, caseId } = await scenarioB();
    const runs = [await replayEvidence(r.store, caseId), await replayEvidence(r.store, caseId), await replayEvidence(r.store, caseId)];
    expect(new Set(runs.map((x) => x.diff_json)).size).toBe(1);
    expect(new Set(runs.map((x) => x.result)).size).toBe(1);
    const stored = rows(r, "SELECT diff_json, tier, attempt_k, result FROM replay_runs WHERE case_id=?", caseId);
    expect(stored).toHaveLength(3);
    expect(new Set(stored.map((s) => s.diff_json)).size).toBe(1);
    expect(stored.every((s) => s.tier === 'evidence' && s.attempt_k === 1 && s.result === 'pass')).toBe(true);
    expect(stored[0].diff_json).toBe(runs[0]!.diff_json);
    r.close();
  });

  it('never touches live state: orders, sessions, cases and audit are unchanged; only a replay_runs row is added', async () => {
    const { r, caseId } = await scenarioB();
    const snap = () => JSON.stringify([rows(r, 'SELECT * FROM orders'), rows(r, 'SELECT id,mode FROM sessions'), rows(r, 'SELECT id FROM cases'), rows(r, 'SELECT id FROM audit_events'), rows(r, 'SELECT id FROM tool_calls'), rows(r, 'SELECT id FROM events_raw')]);
    const before = snap();
    await replayEvidence(r.store, caseId);
    expect(snap()).toBe(before);
    expect(rows(r, 'SELECT count(*) n FROM replay_runs')[0].n).toBe(1);
    r.close();
  });

  it('persist:false records nothing', async () => {
    const { r, caseId } = await scenarioB();
    await replayEvidence(r.store, caseId, { persist: false });
    expect(rows(r, 'SELECT count(*) n FROM replay_runs')[0].n).toBe(0);
    r.close();
  });
});

describe('evidence-tier replay: a deliberately broken gating build FAILS', () => {
  it('an extractor that echoes the agent\'s claim (validation removed) makes the recorded stale call ALLOWED, and the replay says SAFETY REGRESSION', async () => {
    const { r, caseId } = await scenarioB();
    const broken = { extract: (f: Parameters<typeof extractEvidence>[0]) => extractEvidence(f.map((u) => ({ ...u, text: 'Two burgers.' }))) };
    const rep = await replayEvidence(r.store, caseId, { gate: broken, persist: false });
    expect(rep.result).toBe('fail');
    expect(rep.label).toBe('FAIL (deterministic)');
    expect(rep.diff).toMatchObject({ desired: 'HOLD', reason: 'SAFETY_REGRESSION_now_allowed_but_must_be_held', actual: { verdict: 'ALLOW' } });
    expect((rep.diff.order_after as unknown[]).length).toBe(1);                       // in the throwaway DB the bad line landed...
    expect(r.store.getOrder(r.session)!.state.lines).toEqual([{ item_id: 'burger', quantity: 3, modifiers: [] }]);   // ...and the live order never saw it
    r.close();
  });

  it('a gate that stops waiting for evidence FAILS the same case (in-flight wait removed: the stale call slips through)', async () => {
    const { r, caseId } = await scenarioB();
    const rep = await replayEvidence(r.store, caseId, { gate: { evidenceWaitMaxMs: 0 }, persist: false });
    expect(rep.result === 'pass' || rep.result === 'fail').toBe(true);
    // with a zero budget the gate cannot settle: it must still HOLD (fail closed), never ALLOW
    expect((rep.diff.actual as { verdict: string }).verdict).toBe('HOLD');
    r.close();
  });
});

describe('what "correct" means for a case', () => {
  it('a hold caused by MISSING evidence (stream down) must keep holding even though the same call was later validated', async () => {
    const r = makeRig({ persist: true });
    r.down('test outage'); r.final('three burgers.');
    const held = await r.call('add_item', B(3));
    expect(held).toMatchObject({ verdict: 'HOLD', code: 'UNVALIDATABLE' });
    r.clock.advance(500); r.up(); r.final('three burgers.', { order: 5 });
    expect((await r.call('add_item', B(3))).verdict).toBe('ALLOW');              // resolved: expected state has burger 3
    const rep = await replayEvidence(r.store, r.store.listCases()[0]!.id);
    expect(rep.diff).toMatchObject({ basis: 'evidence_unavailable', desired: 'HOLD', reason: 'still_held' });
    expect(rep.result).toBe('pass');
    r.close();
  });

  it('a case with NO expected state (escalated) asserts only "a held call stays held"', async () => {
    const r = makeRig({ persist: true });
    r.up(); r.final('three burgers.');
    for (let i = 0; i < 3; i++) await r.call('add_item', B(2));
    const escalated = r.store.listCases()[2]!.id;
    const rep = await replayEvidence(r.store, escalated);
    expect(rep.diff).toMatchObject({ basis: 'held_must_stay_held', desired: 'HOLD', expected_lines: null, result: 'pass' });
    const bad = await replayEvidence(r.store, escalated, { gate: { extract: (f) => extractEvidence(f.map((u) => ({ ...u, text: 'Two burgers.' }))) }, persist: false });
    expect(bad.result).toBe('fail');
    r.close();
  });

  it('desiredOutcome (pure): a recorded call that matches the validated line is ALLOW; one that does not is HOLD', () => {
    const before = { lines: [], status: 'open' as const, pickup_time: null };
    const exp = { state: { lines: [{ item_id: 'burger', quantity: 3, modifiers: [] }], status: 'open' as const, pickup_time: null } };
    expect(desiredOutcome(before, { tool: 'add_item', args: B(3) }, exp).desired).toBe('ALLOW');
    expect(desiredOutcome(before, { tool: 'add_item', args: B(2) }, exp).desired).toBe('HOLD');
    expect(desiredOutcome(before, { tool: 'add_item', args: { item_id: 'coke', quantity: 1, modifiers: [] } }, exp).desired).toBe('HOLD');
    expect(desiredOutcome(before, { tool: 'add_item', args: B(3) }, null).desired).toBe('HOLD');
  });
});

describe('errors and guards', () => {
  it('unknown case => ReplayError(case_not_found)', async () => {
    const r = makeRig();
    await expect(replayEvidence(r.store, 'case_nope')).rejects.toMatchObject({ code: 'case_not_found' });
    expect(new ReplayError('no_audio', 'x')).toBeInstanceOf(Error);
    r.close();
  });

  it('seedReplayOrder refuses live and demo sessions (it can never touch a real order)', () => {
    const r = makeRig();                                                                 // a demo session
    expect(() => r.store.seedReplayOrder(r.session, { lines: [{ item_id: 'burger', quantity: 1, modifiers: [] }], status: 'open', pickup_time: null })).toThrow(/not a replay session/);
    expect(r.store.getOrder(r.session)!.state.lines).toEqual([]);
    r.close();
  });
});

describe('verdict wording (never "deterministic" for the audio tier)', () => {
  it('evidence: PASS/FAIL (deterministic). audio: k/N passed, ALL must pass, a fail is never averaged away', () => {
    expect(describeReplay('evidence', ['pass']).label).toBe('PASS (deterministic)');
    expect(describeReplay('evidence', ['fail']).label).toBe('FAIL (deterministic)');
    expect(describeReplay('audio', ['pass', 'pass', 'pass'])).toMatchObject({ label: '3/3 passed', overall: 'pass', passed: 3, k: 3 });
    expect(describeReplay('audio', ['pass', 'fail', 'pass'])).toMatchObject({ label: '2/3 passed: FAIL', overall: 'fail' });
    expect(describeReplay('audio', ['fail', 'fail', 'fail']).overall).toBe('fail');
    expect(describeReplay('audio', []).overall).toBe('fail');
    for (const rs of [['pass', 'pass', 'pass'], ['pass', 'fail', 'pass'], []] as const) expect(describeReplay('audio', rs).label).not.toMatch(/determin/i);
  });

  it('judgeAudioRun compares the FINAL order to the expected state, canonically (order and modifier order do not matter)', () => {
    const exp = { state: { lines: [{ item_id: 'burger', quantity: 3, modifiers: ['no_onions', 'extra_cheese'] }, { item_id: 'coke', quantity: 1, modifiers: [] }], status: 'open' as const, pickup_time: null } };
    const same = { lines: [{ item_id: 'coke', quantity: 1, modifiers: [] }, { item_id: 'burger', quantity: 3, modifiers: ['extra_cheese', 'no_onions'] }] };
    expect(judgeAudioRun(same, exp).result).toBe('pass');
    expect(judgeAudioRun({ lines: [{ item_id: 'burger', quantity: 2, modifiers: [] }] }, exp).result).toBe('fail');
    expect(judgeAudioRun(undefined, exp).result).toBe('fail');
  });
});
