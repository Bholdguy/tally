// Step 9: config registry and promotion persistence. Beside the committer because it writes; called only from Store.
// Rules enforced HERE (not just in the API): versions are immutable and never overwritten (rule 4, plus DB triggers); a version
// becomes ACTIVE only through `activate`, which requires a passing, fresh, unconsumed suite run for exactly that version.
import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '@tally/db';

export interface GatingParams {
  evidenceWaitMaxMs?: number; minWordConfidence?: number; sttStallMs?: number; maxRepairAttempts?: number; regressionThreshold?: number;
}
const PARAM_RANGES: Record<keyof GatingParams, [number, number, boolean]> = {   // [min, max, integer]
  evidenceWaitMaxMs: [0, 30000, true], minWordConfidence: [0, 1, false], sttStallMs: [100, 30000, true], maxRepairAttempts: [1, 5, true], regressionThreshold: [2, 20, true],
};
export class ConfigError extends Error {
  constructor(readonly code: 'CONFIG_EXISTS' | 'BAD_CONFIG' | 'NOT_FOUND' | 'NO_PARENT' | 'INTEGRITY' | 'SUITE_REQUIRED' | 'SUITE_MISMATCH' | 'SUITE_NOT_PASSED' | 'SUITE_STALE' | 'SUITE_CONSUMED' | 'ALREADY_ACTIVE' | 'BASELINE_EXISTS' | 'NOTHING_TO_ROLL_BACK', msg: string) { super(msg); }
}

/** a prompt is stored, hashed and sent to the agent: bound it (a 50 MB "prompt" is an attack, not a config) */
export const MAX_PROMPT_CHARS = 100_000;

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export function validateGatingParams(p: unknown): GatingParams {
  if (p === undefined || p === null) return {};
  if (typeof p !== 'object' || Array.isArray(p)) throw new ConfigError('BAD_CONFIG', 'gating_params must be an object');
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
    // own keys only: `constructor`, `toString`, `__proto__` resolve on Object.prototype and would slip through a plain lookup
    const r = Object.hasOwn(PARAM_RANGES, k) ? PARAM_RANGES[k as keyof GatingParams] : undefined;
    if (!r) throw new ConfigError('BAD_CONFIG', `unknown gating parameter "${k}"`);
    if (typeof v !== 'number' || !Number.isFinite(v) || v < r[0] || v > r[1] || (r[2] && !Number.isInteger(v))) throw new ConfigError('BAD_CONFIG', `gating parameter ${k} must be ${r[2] ? 'an integer' : 'a number'} in [${r[0]}, ${r[1]}]`);
    out[k] = v;
  }
  return out as GatingParams;
}

export interface ConfigRow {
  id: string; version: string; prompt_hash: string; tool_schema_hash: string; created_at: number; promoted: 0 | 1;
  prompt_text: string; tool_schema_json: string; turn_detection_json: string; gating_params_json: string; parent_version: string | null;
}
export type ConfigWithIntegrity = ConfigRow & { integrity_ok: boolean; gating_params: GatingParams };

const withIntegrity = (r: ConfigRow): ConfigWithIntegrity => ({
  ...r, gating_params: JSON.parse(r.gating_params_json) as GatingParams,
  // hashes are verified on every load (SECURITY §4): a row whose text no longer matches its hash is never trusted
  integrity_ok: sha256(r.prompt_text) === r.prompt_hash && sha256(r.tool_schema_json) === r.tool_schema_hash,
});

export const getConfig = (db: Db, version: string): ConfigWithIntegrity | undefined => {
  const r = db.prepare('SELECT * FROM configs WHERE version=?').get(version) as ConfigRow | undefined;
  return r ? withIntegrity(r) : undefined;
};
export const activeConfig = (db: Db): ConfigWithIntegrity | undefined => {
  const r = db.prepare('SELECT * FROM configs WHERE promoted=1').get() as ConfigRow | undefined;
  return r ? withIntegrity(r) : undefined;
};
export const listConfigs = (db: Db): ConfigWithIntegrity[] => (db.prepare('SELECT * FROM configs ORDER BY created_at, rowid').all() as ConfigRow[]).map(withIntegrity);

const event = (db: Db, version: string, action: string, actor: string, suite_run_id: string | null, detail: unknown): void => {
  db.prepare('INSERT INTO config_events(id,version,action,at,actor,suite_run_id,detail_json) VALUES(?,?,?,?,?,?,?)').run(`cfg_${randomUUID()}`, version, action, Date.now(), actor, suite_run_id, JSON.stringify(detail ?? {}));
};

export function createConfig(db: Db, p: { version: string; prompt_text: string; tool_schema_json: string; gating_params?: unknown; parent_version?: string | null; actor?: string }): ConfigWithIntegrity {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(p.version)) throw new ConfigError('BAD_CONFIG', 'version must be 1-40 characters: letters, digits, . _ -');
  if (typeof p.prompt_text !== 'string' || p.prompt_text.trim().length < 20) throw new ConfigError('BAD_CONFIG', 'prompt_text is required (at least 20 characters)');
  if (p.prompt_text.length > MAX_PROMPT_CHARS) throw new ConfigError('BAD_CONFIG', `prompt_text is too long (max ${MAX_PROMPT_CHARS} characters)`);
  // names that resolve on Object.prototype (`constructor`, `toString`, ...) are refused: versions are used as object keys downstream
  if (p.version in Object.prototype) throw new ConfigError('BAD_CONFIG', `"${p.version}" is a reserved name`);
  if (p.parent_version !== undefined && p.parent_version !== null && typeof p.parent_version !== 'string') throw new ConfigError('BAD_CONFIG', 'parent_version must be a string');
  const params = validateGatingParams(p.gating_params);
  return db.transaction((): ConfigWithIntegrity => {
    if (db.prepare('SELECT 1 FROM configs WHERE version=?').get(p.version)) throw new ConfigError('CONFIG_EXISTS', `version ${p.version} already exists: versions are immutable, create a new one`);
    const parent = p.parent_version === undefined ? activeConfig(db)?.version ?? null : p.parent_version;
    if (parent && !db.prepare('SELECT 1 FROM configs WHERE version=?').get(parent)) throw new ConfigError('NO_PARENT', `parent version ${parent} does not exist`);
    db.prepare('INSERT INTO configs(id,version,prompt_hash,tool_schema_hash,created_at,promoted,prompt_text,tool_schema_json,turn_detection_json,gating_params_json,parent_version) VALUES(?,?,?,?,?,0,?,?,?,?,?)')
      .run(`cfg_${randomUUID()}`, p.version, sha256(p.prompt_text), sha256(p.tool_schema_json), Date.now(), p.prompt_text, p.tool_schema_json, '{}', JSON.stringify(params), parent);
    event(db, p.version, 'create', p.actor ?? 'operator', null, { parent_version: parent });
    return getConfig(db, p.version)!;
  })();
}

/** The very first version: activated without a suite because there is nothing to regress against. Refused once any version is active. */
export function activateBaseline(db: Db, version: string): void {
  db.transaction(() => {
    if (db.prepare('SELECT 1 FROM configs WHERE promoted=1').get()) throw new ConfigError('BASELINE_EXISTS', 'a version is already active');
    const c = getConfig(db, version);
    if (!c) throw new ConfigError('NOT_FOUND', `no config ${version}`);
    if (!c.integrity_ok) throw new ConfigError('INTEGRITY', `config ${version} fails its hash check`);
    db.prepare('UPDATE configs SET promoted=1 WHERE version=?').run(version);
    event(db, version, 'baseline', 'system', null, {});
  })();
}

export interface SuiteRunInput {
  id: string; config_version: string; started_at: number; status: 'passed' | 'blocked'; case_ids: string[]; evidence: unknown;
  audio_requested: boolean; audio: unknown; blocking: unknown[];
}
export function insertSuiteRun(db: Db, r: SuiteRunInput): void {
  db.transaction(() => {
    db.prepare('INSERT INTO suite_runs(id,config_version,started_at,finished_at,status,case_ids_json,evidence_json,audio_requested,audio_json,blocking_json) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(r.id, r.config_version, r.started_at, Date.now(), r.status, JSON.stringify([...r.case_ids].sort()), JSON.stringify(r.evidence), r.audio_requested ? 1 : 0, r.audio === null ? null : JSON.stringify(r.audio), JSON.stringify(r.blocking));
    if (r.status === 'blocked') event(db, r.config_version, 'blocked', 'plane2', r.id, { blocking: r.blocking });
  })();
}

export interface SuiteRunRow { id: string; config_version: string; started_at: number; finished_at: number; status: 'passed' | 'blocked'; case_ids_json: string; evidence_json: string; audio_requested: number; audio_json: string | null; blocking_json: string; consumed_at: number | null }
export const getSuiteRun = (db: Db, id: string): SuiteRunRow | undefined => (typeof id === 'string' && id.length <= 200 ? (db.prepare('SELECT * FROM suite_runs WHERE id=?').get(id) as SuiteRunRow | undefined) : undefined);
export const currentRegressionIds = (db: Db): string[] => (db.prepare("SELECT id FROM cases WHERE tag='regression' ORDER BY id").all() as { id: string }[]).map((r) => r.id);

/**
 * THE promotion gate at the data layer. A version becomes active ONLY with a suite run that (1) is for exactly this version,
 * (2) PASSED, (3) ran exactly the regression set that exists NOW (a case accepted since makes it stale), and (4) has not already
 * been used. The config's own hashes must also verify. Any failure throws; nothing is written.
 */
export function activate(db: Db, version: string, suite_run_id: string | undefined, actor = 'operator'): { previous: string | null } {
  return db.transaction(() => {
    const c = getConfig(db, version);
    if (!c) throw new ConfigError('NOT_FOUND', `no config ${version}`);
    if (c.promoted === 1) throw new ConfigError('ALREADY_ACTIVE', `${version} is already active`);
    if (!c.integrity_ok) throw new ConfigError('INTEGRITY', `config ${version} fails its hash check`);
    if (!suite_run_id) throw new ConfigError('SUITE_REQUIRED', 'promotion needs a passing suite run for this version (run all cases first)');
    // a non-string id (an object, a number) can never name a suite run; it must not reach the SQL binder
    const s = typeof suite_run_id === 'string' && suite_run_id.length <= 200 ? getSuiteRun(db, suite_run_id) : undefined;
    if (!s || s.config_version !== version) throw new ConfigError('SUITE_MISMATCH', 'that suite run is not for this version');
    if (s.status !== 'passed') throw new ConfigError('SUITE_NOT_PASSED', 'that suite run did not pass');
    if (s.consumed_at !== null) throw new ConfigError('SUITE_CONSUMED', 'that suite run was already used for a promotion; run the suite again');
    if (JSON.stringify(currentRegressionIds(db)) !== s.case_ids_json) throw new ConfigError('SUITE_STALE', 'the regression set changed since that run; run all cases again');
    const prev = activeConfig(db)?.version ?? null;
    if (prev) db.prepare('UPDATE configs SET promoted=0 WHERE version=?').run(prev);
    db.prepare('UPDATE configs SET promoted=1 WHERE version=?').run(version);
    db.prepare('UPDATE suite_runs SET consumed_at=? WHERE id=?').run(Date.now(), suite_run_id);
    event(db, version, 'promote', actor, suite_run_id, { previous: prev, audio_requested: !!s.audio_requested });
    return { previous: prev };
  })();
}

/** Re-activates the PARENT of the active version. The parent must itself have been active before (promote/baseline event) and verify its hashes. */
export function rollback(db: Db, actor = 'operator'): { from: string; to: string } {
  return db.transaction(() => {
    const cur = activeConfig(db);
    if (!cur || !cur.parent_version) throw new ConfigError('NOTHING_TO_ROLL_BACK', 'the active version has no parent to return to');
    const parent = getConfig(db, cur.parent_version);
    if (!parent) throw new ConfigError('NO_PARENT', `parent ${cur.parent_version} is missing`);
    if (!parent.integrity_ok) throw new ConfigError('INTEGRITY', `parent ${parent.version} fails its hash check`);
    if (!db.prepare("SELECT 1 FROM config_events WHERE version=? AND action IN ('promote','baseline')").get(parent.version)) throw new ConfigError('NOTHING_TO_ROLL_BACK', `parent ${parent.version} was never active`);
    db.prepare('UPDATE configs SET promoted=0 WHERE version=?').run(cur.version);
    db.prepare('UPDATE configs SET promoted=1 WHERE version=?').run(parent.version);
    event(db, parent.version, 'rollback', actor, null, { from: cur.version });
    return { from: cur.version, to: parent.version };
  })();
}

export const configHistory = (db: Db, version?: string) =>
  db.prepare(`SELECT * FROM config_events ${version ? 'WHERE version=?' : ''} ORDER BY rowid`).all(...(version ? [version] : [])) as { id: string; version: string; action: string; at: number; actor: string; suite_run_id: string | null; detail_json: string }[];

/** cases x config versions: the latest replay result per (case, version, tier) */
export function compareTable(db: Db): { case_id: string; pattern_key: string; tag: string; by_version: Record<string, { evidence?: 'pass' | 'fail'; audio?: string }> }[] {
  const cases = db.prepare("SELECT id, pattern_key, tag FROM cases ORDER BY created_at, rowid").all() as { id: string; pattern_key: string; tag: string }[];
  const runs = db.prepare('SELECT case_id, agent_config_version v, tier, result, attempt_k, suite_run_id FROM replay_runs ORDER BY rowid').all() as { case_id: string; v: string; tier: string; result: 'pass' | 'fail'; attempt_k: number; suite_run_id: string | null }[];
  return cases.map((c) => {
    const by: Record<string, { evidence?: 'pass' | 'fail'; audio?: string }> = Object.create(null);
    for (const r of runs.filter((x) => x.case_id === c.id)) {
      by[r.v] ??= {};
      if (r.tier === 'evidence') by[r.v]!.evidence = r.result;
    }
    for (const v of Object.keys(by)) {
      const audio = runs.filter((x) => x.case_id === c.id && x.v === v && x.tier === 'audio');
      const last = audio.length ? audio[audio.length - 1]!.suite_run_id : null;
      const set = audio.filter((a) => a.suite_run_id === last);
      if (set.length) by[v]!.audio = `${set.filter((a) => a.result === 'pass').length}/${set.length} passed`;   // never "deterministic"
    }
    return { case_id: c.id, pattern_key: c.pattern_key, tag: c.tag, by_version: by };
  });
}
