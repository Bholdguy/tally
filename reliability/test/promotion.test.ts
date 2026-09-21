// Step 9: config registry, "run all cases", and the promotion gate. Business outcomes: a config that breaks a previously-passing
// regression case is BLOCKED and the response names the case; a passing config promotes; versions can never be overwritten.
import { describe, expect, it } from 'vitest';
import { toolDeclarations } from '@tally/contract';
import { ConfigError } from '../src/committer-configs.js';
import type { Store } from '../src/committer.js';
import { runSuite, SUITE_VALIDATION_NOTICE } from '../src/promotion.js';
import { makeRig, type Rig } from './rig.js';

const PROMPT = 'You are the voice ordering assistant. Keep replies short and natural.';
const TOOLS = JSON.stringify(toolDeclarations());
const B = (q: number) => ({ item_id: 'burger', quantity: q, modifiers: [] as string[] });
const mk = (s: Store, version: string, over: { prompt?: string; params?: unknown; parent?: string | null } = {}) =>
  s.createConfig({ version, prompt_text: over.prompt ?? PROMPT, tool_schema_json: TOOLS, gating_params: over.params, parent_version: over.parent });
const rowsOf = (r: Rig, sql: string, ...p: unknown[]) => r.store.r.prepare(sql).all(...p) as any[];

/** A misheard quantity: the independent stream is only 0.4 confident in "two" (the customer said "three"); the agent's call add(2) is HELD (low confidence),
 *  the customer repeats, add(3) re-validates. The operator accepts it as a regression. It protects the confidence check. */
async function lowConfidenceRegression(r: Rig): Promise<string> {
  r.up(); r.final('two burgers.', { conf: 0.4 });
  const held = await r.call('add_item', B(2));
  expect(held).toMatchObject({ verdict: 'HOLD', code: 'UNVALIDATABLE' });
  const id = r.store.listCases({ session_id: r.session })[0]!.id;
  r.clock.advance(500); r.final('three burgers.', { conf: 0.9 });
  expect((await r.call('add_item', B(3))).verdict).toBe('ALLOW');
  expect(r.store.acceptRegression(id, 'operator')).toEqual({ ok: true });
  return id;
}
/** A different pattern (plain QTY_MISMATCH), unaffected by the confidence parameter. */
async function quantityRegression(store: Store, path: string, session: string): Promise<string> {
  const r = makeRig({ persist: true, regressionThreshold: 1, sharedStore: store, sharedPath: path, session });
  r.up(); r.final('three burgers and a coke.');
  await r.call('add_item', B(2));
  const id = store.listCases({ session_id: session })[0]!.id;
  await r.call('add_item', B(3));
  expect(store.acceptRegression(id, 'operator')).toEqual({ ok: true });
  return id;
}
async function world() {
  const r = makeRig({ persist: true, regressionThreshold: 1 });
  mk(r.store, 'v1'); r.store.activateBaseline('v1');
  const id = await lowConfidenceRegression(r);
  return { r, id, s: r.store };
}

describe('config registry: versions are immutable and never overwritten', () => {
  it('stores hashes; an existing version cannot be recreated; prompt/schema/params cannot be updated or deleted (DB triggers)', () => {
    const r = makeRig();
    const c = mk(r.store, 'v1');
    expect(c).toMatchObject({ version: 'v1', promoted: 0, integrity_ok: true, parent_version: null });
    expect(c.prompt_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(c.tool_schema_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(() => mk(r.store, 'v1', { prompt: `${PROMPT} changed` })).toThrow(expect.objectContaining({ code: 'CONFIG_EXISTS' }));
    const w = (r.store as any).w;
    expect(() => w.exec("UPDATE configs SET prompt_text='x' WHERE version='v1'")).toThrow(/immutable/);
    expect(() => w.exec("UPDATE configs SET gating_params_json='{}' WHERE version='v1'")).toThrow(/immutable/);
    expect(() => w.exec("DELETE FROM configs WHERE version='v1'")).toThrow(/never deleted/);
    expect(r.store.getConfig('v1')!.prompt_text).toBe(PROMPT);
    r.close();
  });

  it('validates input: version name, prompt, unknown/out-of-range/non-integer gating parameters', () => {
    const r = makeRig();
    const bad = (f: () => unknown) => expect(f).toThrow(expect.objectContaining({ code: 'BAD_CONFIG' }));
    bad(() => mk(r.store, 'bad version!'));
    bad(() => mk(r.store, 'v1', { prompt: 'short' }));
    bad(() => mk(r.store, 'v1', { params: { nope: 1 } }));
    bad(() => mk(r.store, 'v1', { params: { minWordConfidence: 1.5 } }));
    bad(() => mk(r.store, 'v1', { params: { evidenceWaitMaxMs: 10.5 } }));
    bad(() => mk(r.store, 'v1', { params: 'x' }));
    expect(() => mk(r.store, 'v1', { parent: 'ghost' })).toThrow(expect.objectContaining({ code: 'NO_PARENT' }));
    expect(r.store.listConfigs()).toEqual([]);
    r.close();
  });

  it('a baseline can be activated once; the parent of a new version defaults to the active one; history is recorded', () => {
    const r = makeRig();
    mk(r.store, 'v1'); r.store.activateBaseline('v1');
    expect(r.store.activeConfig()!.version).toBe('v1');
    expect(() => r.store.activateBaseline('v1')).toThrow(expect.objectContaining({ code: 'BASELINE_EXISTS' }));
    expect(mk(r.store, 'v2').parent_version).toBe('v1');
    expect(r.store.configHistory().map((e) => `${e.version}:${e.action}`)).toEqual(['v1:create', 'v1:baseline', 'v2:create']);
    r.close();
  });

  it('a row whose stored text no longer matches its hash is never trusted: integrity_ok=false, suite blocks, activation refuses', async () => {
    const { r, s } = await world();
    (s as any).w.prepare("INSERT INTO configs(id,version,prompt_hash,tool_schema_hash,created_at,prompt_text,tool_schema_json,gating_params_json,parent_version) VALUES('x','vbad','deadbeef','deadbeef',1,'tampered prompt text here','[]','{}','v1')").run();
    expect(s.getConfig('vbad')!.integrity_ok).toBe(false);
    const rep = await runSuite(s, { config_version: 'vbad' });
    expect(rep.status).toBe('blocked');
    expect(rep.blocking.some((b) => b.reason === 'CONFIG_INTEGRITY')).toBe(true);
    expect(() => s.activateConfig('vbad', rep.suite_run_id)).toThrow(expect.objectContaining({ code: 'INTEGRITY' }));
    r.close();
  });
});

describe('the promotion gate', () => {
  it('a PASSING config promotes: suite passes, the version becomes active, the previous one is recorded, history shows it', async () => {
    const { r, s, id } = await world();
    mk(s, 'v2', { params: { evidenceWaitMaxMs: 3500 } });
    const rep = await runSuite(s, { config_version: 'v2' });
    expect(rep).toMatchObject({ status: 'passed', vacuous: false, suite_size: 1, label: 'PASSED 1/1 regression cases' });
    expect(rep.cases).toEqual([expect.objectContaining({ case_id: id, evidence: 'pass' })]);
    expect(s.activateConfig('v2', rep.suite_run_id)).toEqual({ previous: 'v1' });
    expect(s.activeConfig()!.version).toBe('v2');
    expect(s.getConfig('v1')!.promoted).toBe(0);
    expect(s.configHistory('v2').map((e) => e.action)).toEqual(['create', 'promote']);
    expect(rowsOf(r, 'SELECT consumed_at FROM suite_runs WHERE id=?', rep.suite_run_id)[0].consumed_at).not.toBeNull();
    // the evidence runs of the suite are stored under the suite id, against the candidate's version
    expect(rowsOf(r, "SELECT agent_config_version v, tier FROM replay_runs WHERE suite_run_id=?", rep.suite_run_id)).toEqual([{ v: 'v2', tier: 'evidence' }]);
    r.close();
  });

  it('a config that BREAKS a previously-passing case is BLOCKED and the response NAMES the case', async () => {
    const { r, s, id } = await world();
    expect((await runSuite(s, { config_version: 'v1' })).status).toBe('passed');      // the baseline passes it: it is "previously passing"
    mk(s, 'v3', { params: { minWordConfidence: 0.1 } });                              // a tuning that lets a misheard quantity through
    const rep = await runSuite(s, { config_version: 'v3' });
    expect(rep.status).toBe('blocked');
    expect(rep.blocking).toEqual([expect.objectContaining({ case_id: id, tier: 'evidence', reason: 'SAFETY_REGRESSION_now_allowed_but_must_be_held', pattern_key: expect.stringContaining('UNVALIDATABLE') })]);
    expect(rep.label).toMatch(/^BLOCKED/);
    expect(() => s.activateConfig('v3', rep.suite_run_id)).toThrow(expect.objectContaining({ code: 'SUITE_NOT_PASSED' }));
    expect(s.activeConfig()!.version).toBe('v1');                                      // nothing changed
    expect(s.configHistory('v3').map((e) => e.action)).toEqual(['create', 'blocked']);
    r.close();
  });

  it('ONE failing case among several blocks the promotion; only the failing one is named', async () => {
    const { r, s, id } = await world();
    const other = await quantityRegression(s, r.path, 's2');
    mk(s, 'v3', { params: { minWordConfidence: 0.1 } });
    const rep = await runSuite(s, { config_version: 'v3' });
    expect(rep.suite_size).toBe(2);
    expect(rep.status).toBe('blocked');
    expect(rep.blocking.map((b) => b.case_id)).toEqual([id]);
    expect(rep.cases.find((c) => c.case_id === other)!.evidence).toBe('pass');
    r.close();
  });

  it('promotion needs a suite run: none, another version\'s, an already-used, or a STALE one (a case was accepted since) are all refused', async () => {
    const { r, s } = await world();
    mk(s, 'v2'); mk(s, 'v3');
    expect(() => s.activateConfig('v2', undefined)).toThrow(expect.objectContaining({ code: 'SUITE_REQUIRED' }));
    const forV2 = await runSuite(s, { config_version: 'v2' });
    expect(() => s.activateConfig('v3', forV2.suite_run_id)).toThrow(expect.objectContaining({ code: 'SUITE_MISMATCH' }));
    expect(() => s.activateConfig('v2', 'suite_nope')).toThrow(expect.objectContaining({ code: 'SUITE_MISMATCH' }));
    // stale: the regression set changes after the run
    await quantityRegression(s, r.path, 's2');
    expect(() => s.activateConfig('v2', forV2.suite_run_id)).toThrow(expect.objectContaining({ code: 'SUITE_STALE' }));
    const fresh = await runSuite(s, { config_version: 'v2' });
    expect(s.activateConfig('v2', fresh.suite_run_id).previous).toBe('v1');
    expect(() => s.activateConfig('v3', fresh.suite_run_id)).toThrow(ConfigError);
    // a used run cannot be replayed to promote again (v2 is now active; go back and try to re-promote with the consumed run)
    s.rollbackConfig();
    expect(() => s.activateConfig('v2', fresh.suite_run_id)).toThrow(expect.objectContaining({ code: 'SUITE_CONSUMED' }));
    expect(s.activeConfig()!.version).toBe('v1');
    r.close();
  });

  it('only regression-tagged cases are in the suite (candidates and untagged cases are not)', async () => {
    const { r, s } = await world();
    const r2 = makeRig({ persist: true, regressionThreshold: 5, sharedStore: s, sharedPath: r.path, session: 's2' });
    r2.up(); r2.final('three burgers.'); await r2.call('add_item', B(2));           // an untagged case
    expect(s.listCases().length).toBe(2);
    mk(s, 'v2');
    expect((await runSuite(s, { config_version: 'v2' })).suite_size).toBe(1);
    r.close();
  });

  it('an EMPTY regression set passes VACUOUSLY and says so', async () => {
    const r = makeRig();
    mk(r.store, 'v1'); r.store.activateBaseline('v1'); mk(r.store, 'v2');
    const rep = await runSuite(r.store, { config_version: 'v2' });
    expect(rep).toMatchObject({ status: 'passed', vacuous: true, suite_size: 0, label: 'PASSED (vacuous: no regression cases yet)' });
    expect(rep.guarantees.join(' ')).toMatch(/NONE: this pass is vacuous/);
    r.close();
  });
});

describe('prompt changes cannot be promoted on evidence-tier results alone', () => {
  it('a changed prompt with regression cases needs the audio tier; with it, all cases must pass k/3; an audio error or a 2/3 blocks', async () => {
    const { r, s, id } = await world();
    mk(s, 'v2', { prompt: `${PROMPT} Always confirm the quantity back.` });
    const noAudio = await runSuite(s, { config_version: 'v2' });
    expect(noAudio.status).toBe('blocked');
    expect(noAudio.audio).toMatchObject({ required: true, ran: false });
    expect(noAudio.blocking[0]).toMatchObject({ tier: 'audio', reason: 'AUDIO_TIER_REQUIRED', case_id: null });

    const pass = await runSuite(s, { config_version: 'v2', audio: async () => ({ overall: 'pass', label: '3/3 passed', k: 3, passed: 3 }) });
    expect(pass.status).toBe('passed');
    expect(pass.cases[0]!.audio).toBe('3/3 passed');
    expect(pass.guarantees[1]).toMatch(/k=3.*never deterministic/);

    const two = await runSuite(s, { config_version: 'v2', audio: async () => ({ overall: 'fail', label: '2/3 passed: FAIL', k: 3, passed: 2 }) });
    expect(two.status).toBe('blocked');
    expect(two.blocking).toEqual([expect.objectContaining({ case_id: id, tier: 'audio', reason: 'AUDIO_2_OF_3_PASSED' })]);

    const boom = await runSuite(s, { config_version: 'v2', audio: async () => { throw new Error('agent unreachable'); } });
    expect(boom.blocking).toEqual([expect.objectContaining({ case_id: id, reason: 'AUDIO_TIER_ERROR', detail: 'agent unreachable' })]);
    expect(s.activeConfig()!.version).toBe('v1');
    r.close();
  });

  it('a gating-parameters-only change does NOT need the audio tier (the evidence tier sees it fully)', async () => {
    const { r, s } = await world();
    mk(s, 'v2', { params: { evidenceWaitMaxMs: 3000 } });
    const rep = await runSuite(s, { config_version: 'v2' });
    expect(rep.audio.required).toBe(false);
    expect(rep.status).toBe('passed');
    r.close();
  });
});

describe('rollback re-activates the parent', () => {
  it('v2 -> rollback -> v1 active; v2 stays in the registry; a baseline (no parent) cannot be rolled back; the parent must have been active', async () => {
    const { r, s } = await world();
    mk(s, 'v2');
    s.activateConfig('v2', (await runSuite(s, { config_version: 'v2' })).suite_run_id);
    expect(s.rollbackConfig()).toEqual({ from: 'v2', to: 'v1' });
    expect(s.activeConfig()!.version).toBe('v1');
    expect(s.getConfig('v2')).toBeDefined();
    expect(s.configHistory().map((e) => `${e.version}:${e.action}`).slice(-1)).toEqual(['v1:rollback']);
    expect(() => s.rollbackConfig()).toThrow(expect.objectContaining({ code: 'NOTHING_TO_ROLL_BACK' }));
    // a parent that was never active cannot be rolled back to
    mk(s, 'v4', { parent: 'v1' });                                                        // never promoted
    mk(s, 'v5', { parent: 'v4' });
    s.activateConfig('v5', (await runSuite(s, { config_version: 'v5' })).suite_run_id);
    expect(() => s.rollbackConfig()).toThrow(expect.objectContaining({ code: 'NOTHING_TO_ROLL_BACK' }));
    expect(s.activeConfig()!.version).toBe('v5');
    r.close();
  });
});

describe('every report carries the validation notice (the guarantee is never overstated)', () => {
  it('notice names synthetic/captured phrasing and the pending real-speech and live-agent validation; it is in passed AND blocked reports', async () => {
    const { r, s } = await world();
    mk(s, 'v2'); mk(s, 'v3', { params: { minWordConfidence: 0.1 } });
    for (const v of ['v2', 'v3']) {
      const rep = await runSuite(s, { config_version: v });
      expect(rep.validation_notice).toBe(SUITE_VALIDATION_NOTICE);
      expect(rep.guarantees.join(' ')).toMatch(/synthetic and captured phrasing only; real-speech pass and live-agent validation pending/);
    }
    expect(SUITE_VALIDATION_NOTICE).toMatch(/SYNTHETIC and CAPTURED/);
    expect(SUITE_VALIDATION_NOTICE).toMatch(/real-speech validation pass/);
    expect(SUITE_VALIDATION_NOTICE).toMatch(/live-agent/);
    r.close();
  });
});

describe('compare table: cases x config versions', () => {
  it('shows the latest evidence result per case and version (v2 passes, v3 fails)', async () => {
    const { r, s, id } = await world();
    mk(s, 'v2'); mk(s, 'v3', { params: { minWordConfidence: 0.1 } });
    await runSuite(s, { config_version: 'v2' }); await runSuite(s, { config_version: 'v3' });
    const t = s.compareTable();
    expect(t.find((x) => x.case_id === id)).toMatchObject({ tag: 'regression', by_version: { v2: { evidence: 'pass' }, v3: { evidence: 'fail' } } });
    r.close();
  });
});
