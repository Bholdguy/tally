// AUDIO TIER of replay (Step 8, PRD G7/G8). The case's stored input PCM is streamed at 1x, in real time, into a FRESH live session
// (mode=replay, same SessionRuntime as live: rule 7) against the managed agent. The LLM is not seedable, so a single run proves
// little: it is run k times (default 3) and reported "k/3 passed"; ALL must pass. It is never called deterministic.
//
// Verdict per attempt: the FINAL order (read back from the database, never from what the agent said) vs the case's expected state.
// A failed attempt (session would not start, agent never called a tool, crash) is recorded as a FAIL, never dropped or retried away.
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { describeReplay, judgeAudioRun, readPcm, ReplayError, type Expected, type ReplayResult, type Store } from '@tally/reliability';
import type { SessionRuntime } from './runtime.js';

export interface AudioAttemptReport { attempt: number; result: ReplayResult; session_id: string | null; duration_ms: number; diff: Record<string, unknown> }
export interface AudioReplayReport {
  case_id: string; tier: 'audio'; suite_run_id: string; k: number; passed: number; overall: ReplayResult; label: string; attempts: AudioAttemptReport[];
  /** wall time of the whole replay: includes the clip length k times (reported separately from the evidence tier, PRD F13) */
  duration_ms: number;
}

export interface AudioReplayOptions {
  store: Store;
  caseId: string;
  /** starts a replay-mode session against the TARGET agent config (the caller decides which prompt/config/keys) */
  startRuntime: (body: { mode: 'replay' }) => Promise<SessionRuntime>;
  k?: number;
  /** silence-tail wait after the last audio byte so the agent can finish speaking and calling tools (default 8000 ms) */
  settleMs?: number;
  configVersion?: string;
  suiteRunId?: string;
  onAttempt?: (a: AudioAttemptReport) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runAudioReplay(o: AudioReplayOptions): Promise<AudioReplayReport> {
  const k = o.k ?? 3;
  if (!Number.isInteger(k) || k < 1 || k > 10) throw new RangeError('k must be an integer 1..10');
  const c = o.store.getCase(o.caseId);
  if (!c) throw new ReplayError('case_not_found', `no case ${o.caseId}`);
  if (!c.expected_state_json) throw new ReplayError('no_expected_state', 'the audio tier judges the final order against an expected state; this case has none (escalated/unresolved/no repair)');
  if (!existsSync(c.audio_pointer)) throw new ReplayError('no_audio', 'the stored recording is missing');
  const expected = JSON.parse(c.expected_state_json) as Expected;
  const pcm = readPcm(c.audio_pointer);
  const suite_run_id = o.suiteRunId ?? `suite_${randomUUID()}`;
  const settle = o.settleMs ?? 8000;
  const t0 = performance.now();
  const attempts: AudioAttemptReport[] = [];

  for (let attempt = 1; attempt <= k; attempt++) {
    const a0 = performance.now();
    let rt: SessionRuntime | undefined;
    let report: AudioAttemptReport;
    try {
      rt = await o.startRuntime({ mode: 'replay' });
      await rt.sendPcm(pcm);                                   // 1x: sendPcm paces to real time (the API drops faster-than-real-time audio)
      await sleep(settle);
      const end = await rt.end();
      const j = judgeAudioRun(end.order, expected);
      report = { attempt, result: j.result, session_id: rt.session_id, duration_ms: performance.now() - a0, diff: { ...j.diff, ingest_errors: end.ingest.errors } };
    } catch (err) {
      try { await rt?.end(); } catch { /* already down */ }
      report = { attempt, result: 'fail', session_id: rt?.session_id ?? null, duration_ms: performance.now() - a0, diff: { tier: 'audio', error: err instanceof Error ? err.message : String(err), equal: false } };
    }
    attempts.push(report);
    o.store.recordReplayRun({
      case_id: c.id, config_version: o.configVersion ?? 'current', result: report.result, tier: 'audio', attempt_k: attempt,
      actual_state_json: JSON.stringify(report.diff.actual_lines ?? null), diff_json: JSON.stringify({ ...report.diff, session_id: report.session_id }), suite_run_id, duration_ms: report.duration_ms,
    });
    o.onAttempt?.(report);
  }
  const d = describeReplay('audio', attempts.map((a) => a.result));
  return { case_id: c.id, tier: 'audio', suite_run_id, k, passed: d.passed, overall: d.overall, label: d.label, attempts, duration_ms: performance.now() - t0 };
}
