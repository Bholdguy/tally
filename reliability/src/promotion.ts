// STEP 9: the promotion gate. "Run all cases" for a candidate config version; a version can become active only if EVERY
// regression-tagged case passes (evidence tier: mandatory, deterministic, 100%; audio tier: k/3, all must pass, when it is run).
//
// READ THIS BEFORE QUOTING A PASS: the gate inherits the validation status of the regression suite it depends on.
// `SUITE_VALIDATION_NOTICE` is attached to every suite report and every promotion response so the guarantee is never overstated.
import { randomUUID } from 'node:crypto';
import type { Store } from './committer.js';
import type { ConfigWithIntegrity } from './committer-configs.js';
import { replayEvidence, type ReplayResult } from './replay.js';

export const SUITE_VALIDATION_NOTICE =
  'This gate is only as strong as its regression suite. The suite consists of operator-accepted cases from SYNTHETIC and CAPTURED phrasing only; ' +
  'the real-speech validation pass (D-26) and the live-agent/live-mic validation (D-27) have NOT run. A pass means: no KNOWN failure regressed. ' +
  'It is not evidence of general reliability on real callers, and the evidence tier exercises the gating parameters, not the agent prompt.';

export interface AudioCaseResult { overall: ReplayResult; label: string; k: number; passed: number; suite_run_id?: string }
export interface SuiteOptions {
  config_version: string;
  /** Provide to run the audio tier (live agent, real time x k per case). Injected so /reliability stays network-free. */
  audio?: (caseId: string, config: ConfigWithIntegrity) => Promise<AudioCaseResult>;
  suiteRunId?: string;
}
export interface BlockingEntry { case_id: string | null; pattern_key: string | null; tier: 'evidence' | 'audio' | 'config'; reason: string; detail?: unknown }
export interface SuiteReport {
  suite_run_id: string; config_version: string; status: 'passed' | 'blocked';
  /** true when there were no regression cases to run: the pass is vacuous and says so */
  vacuous: boolean;
  suite_size: number;
  cases: { case_id: string; pattern_key: string; evidence: ReplayResult; audio?: string }[];
  blocking: BlockingEntry[];
  audio: { requested: boolean; required: boolean; ran: boolean };
  guarantees: string[];
  validation_notice: string;
  label: string;
}

export async function runSuite(store: Store, o: SuiteOptions): Promise<SuiteReport> {
  const started = Date.now();
  const suite_run_id = o.suiteRunId ?? `suite_${randomUUID()}`;
  const cfg = store.getConfig(o.config_version);
  if (!cfg) throw new Error(`no config ${o.config_version}`);
  const ids = store.currentRegressionIds();
  const cases = store.listCases({ tag: 'regression' });
  const blocking: BlockingEntry[] = [];
  const per: SuiteReport['cases'] = [];
  const evidenceRows: unknown[] = [];
  const audioRows: unknown[] = [];

  if (!cfg.integrity_ok) blocking.push({ case_id: null, pattern_key: null, tier: 'config', reason: 'CONFIG_INTEGRITY', detail: 'the stored prompt/tool schema no longer matches its hash' });

  // A changed prompt (or tool schema) is invisible to the evidence tier, which replays stored events through the GATING code only.
  const parent = cfg.parent_version ? store.getConfig(cfg.parent_version) : undefined;
  const behaviourChanged = !!parent && (parent.prompt_hash !== cfg.prompt_hash || parent.tool_schema_hash !== cfg.tool_schema_hash);
  const audioRequired = behaviourChanged && cases.length > 0;
  if (audioRequired && !o.audio) {
    blocking.push({ case_id: null, pattern_key: null, tier: 'audio', reason: 'AUDIO_TIER_REQUIRED', detail: `the prompt or tool schema differs from ${parent!.version}; the evidence tier cannot see that change, so the audio tier (k/3) must run and pass` });
  }

  for (const c of cases) {
    const ev = await replayEvidence(store, c.id, {
      gate: { evidenceWaitMaxMs: cfg.gating_params.evidenceWaitMaxMs, minWordConfidence: cfg.gating_params.minWordConfidence },
      sttStallMs: cfg.gating_params.sttStallMs, configVersion: cfg.version, suiteRunId: suite_run_id,
    });
    evidenceRows.push({ case_id: c.id, result: ev.result, reason: ev.diff.reason, desired: ev.diff.desired, actual: ev.diff.actual, diff_json: ev.diff_json });
    const row: SuiteReport['cases'][number] = { case_id: c.id, pattern_key: c.pattern_key, evidence: ev.result };
    if (ev.result === 'fail') blocking.push({ case_id: c.id, pattern_key: c.pattern_key, tier: 'evidence', reason: String(ev.diff.reason), detail: { desired: ev.diff.desired, actual: ev.diff.actual, basis: ev.diff.basis } });
    if (o.audio) {
      try {
        const a = await o.audio(c.id, cfg);
        row.audio = a.label;
        audioRows.push({ case_id: c.id, ...a });
        if (a.overall === 'fail') blocking.push({ case_id: c.id, pattern_key: c.pattern_key, tier: 'audio', reason: `AUDIO_${a.passed}_OF_${a.k}_PASSED`, detail: { label: a.label } });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        row.audio = 'error';
        audioRows.push({ case_id: c.id, error: msg });
        blocking.push({ case_id: c.id, pattern_key: c.pattern_key, tier: 'audio', reason: 'AUDIO_TIER_ERROR', detail: msg });
      }
    }
    per.push(row);
  }

  const status: 'passed' | 'blocked' = blocking.length === 0 ? 'passed' : 'blocked';
  store.insertSuiteRun({
    id: suite_run_id, config_version: cfg.version, started_at: started, status, case_ids: ids, evidence: evidenceRows,
    audio_requested: !!o.audio, audio: o.audio ? audioRows : null, blocking,
  });
  const vacuous = cases.length === 0;
  const guarantees = [
    `evidence tier: ${cases.length} regression case(s) re-run deterministically against ${cfg.version}'s gating parameters` + (vacuous ? ' (NONE: this pass is vacuous)' : ''),
    o.audio ? `audio tier: ${cases.length} case(s) x k=3 live runs against ${cfg.version}'s prompt (reported k/3, never deterministic)` : 'audio tier: NOT run (the agent prompt was not exercised)',
    'validation status: synthetic and captured phrasing only; real-speech pass and live-agent validation pending',
  ];
  const label = status === 'passed' ? (vacuous ? 'PASSED (vacuous: no regression cases yet)' : `PASSED ${cases.length}/${cases.length} regression cases`) : `BLOCKED by ${new Set(blocking.map((b) => b.case_id ?? b.reason)).size} failing check(s)`;
  return {
    suite_run_id, config_version: cfg.version, status, vacuous, suite_size: cases.length, cases: per, blocking,
    audio: { requested: !!o.audio, required: audioRequired, ran: !!o.audio }, guarantees, validation_notice: SUITE_VALIDATION_NOTICE, label,
  };
}
