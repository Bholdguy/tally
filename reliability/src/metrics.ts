// STEP 12: observability. EVERY number here is computed from stored rows at request time (rule 5): no hand-typed values, no cached
// counters, no separate copy that can drift from the evidence. The tests recompute each metric independently from the raw rows.
//
// Latency is CLIENT-OBSERVED (measured on Tally's session clock from what Tally saw and did; PRD G3), not AssemblyAI-internal time.
import type { Store } from './committer.js';
import { desiredOutcome, type Expected } from './replay.js';
import type { OrderState } from './order.js';

export interface StageStats { n: number; p50: number | null; p95: number | null; max: number | null; mean: number | null }
export interface Metrics {
  generated_from: 'stored rows';
  latency_basis: 'client-observed';
  stages: {
    /** end of customer speech (local check) -> independent stream's final transcript */
    stt: StageStats;
    /** tool call received -> gate verdict (includes any evidence wait) */
    gate: StageStats;
    /** hold -> the re-validated commit that resolved it */
    repair: StageStats;
    /** duration of the commit transaction */
    commit: StageStats;
    /** end of customer speech (local check) -> first AUDIBLE agent audio */
    first_audio: StageStats;
    /** derived barge-in: customer speech onset -> the agent's reply cut off */
    barge_in: StageStats;
  };
  counts: { sessions: number; ended_sessions: number; gated_calls: number; allowed: number; held_or_conflict: number; cases: number; regression_candidates: number; regressions: number; replay_runs: number };
  rates: {
    conflict_rate: { value: number | null; n: number; of: number };
    repair_success_rate: { value: number | null; n: number; of: number };
    /** holds that were judged (case with a validated expected state) where the recorded call was actually CORRECT */
    false_positive_rate: { value: number | null; n: number; of: number; note: string };
    /** latest evidence-tier result per regression case */
    regression_pass_rate: { value: number | null; n: number; of: number };
    /** ended sessions with a DECLARED intent whose final order equals it */
    final_order_accuracy: { value: number | null; n: number; of: number; note: string };
  };
}

/** nearest-rank percentile on an unsorted sample (p in 1..100): the smallest value with at least p% of the sample at or below it */
export function percentile(sample: readonly number[], p: number): number | null {
  if (!sample.length) return null;
  const s = [...sample].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}
export function stats(sample: readonly number[]): StageStats {
  if (!sample.length) return { n: 0, p50: null, p95: null, max: null, mean: null };
  return { n: sample.length, p50: percentile(sample, 50), p95: percentile(sample, 95), max: Math.max(...sample), mean: sample.reduce((a, b) => a + b, 0) / sample.length };
}
const rate = (n: number, of: number) => ({ value: of ? n / of : null, n, of });

type Row = Record<string, any>;

export function computeMetrics(store: Store): Metrics {
  const db = store.r;
  const all = (sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as Row[];
  const one = (sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as Row;

  // ---- stt and first_audio: from the stored event stream, per session, in arrival order
  const stt: number[] = []; const firstAudio: number[] = [];
  const events = all("SELECT session_id, type, payload_json, t_ms FROM events_raw WHERE type IN ('local_vad','evidence_transcript','reply_audible') ORDER BY session_id, t_ms, rowid");
  let cur = ''; let endForStt: number | null = null; let endForAudio: number | null = null;
  for (const e of events) {
    if (e.session_id !== cur) { cur = e.session_id; endForStt = null; endForAudio = null; }
    const p = JSON.parse(e.payload_json) as Row;
    if (e.type === 'local_vad') { if (p.state === 'speech_end') { endForStt = e.t_ms; endForAudio = e.t_ms; } else { endForStt = null; endForAudio = null; } }
    else if (e.type === 'evidence_transcript' && p.end_of_turn === true && endForStt !== null && e.t_ms >= endForStt) { stt.push(e.t_ms - endForStt); endForStt = null; }
    else if (e.type === 'reply_audible' && endForAudio !== null && e.t_ms >= endForAudio) { firstAudio.push(e.t_ms - endForAudio); endForAudio = null; }
  }

  // ---- gate and commit: from the recorded tool calls (the spoken-claim rows are not gated calls)
  const gated = all("SELECT status, t_received_ms, t_verdict_ms, t_commit_ms FROM tool_calls WHERE tool_name != 'agent_speech'");
  const gate = gated.filter((r) => r.t_received_ms !== null && r.t_verdict_ms !== null).map((r) => r.t_verdict_ms - r.t_received_ms);
  const commit = gated.filter((r) => r.status === 'allowed' && r.t_commit_ms !== null).map((r) => r.t_commit_ms as number);

  // ---- repair: hold -> resolving commit (wall clock on both rows)
  const repair = all(`SELECT r.resolved_at AS resolved_at, t.timestamp AS held_at FROM repair_events r JOIN tool_calls t ON t.id = r.tool_call_id
                      WHERE r.outcome='resolved' AND r.resolved_at IS NOT NULL AND r.reason NOT IN ('SPOKEN_STATE_DRIFT','TOTAL_MISMATCH')`).map((r) => r.resolved_at - r.held_at);
  const barge = all("SELECT reaction_ms FROM vad_events WHERE type='barge_in' AND reaction_ms IS NOT NULL").map((r) => r.reaction_ms as number);

  // ---- rates
  const held = gated.filter((r) => r.status !== 'allowed').length;
  const cases = all('SELECT id, tool_call_id, resolution, expected_state_json, pattern_key, tag, event_snapshot_json FROM cases');
  const withRepair = cases.filter((c) => c.resolution !== 'no_repair');
  const repairOk = withRepair.filter((c) => c.resolution === 'resolved').length;

  let judged = 0; let fp = 0;
  for (const c of cases) {
    if (!c.expected_state_json) continue;
    const snap = JSON.parse(c.event_snapshot_json) as { call: { tool: string; args: Record<string, unknown> }; order_before: OrderState | null };
    if (!snap.order_before || snap.call.tool === 'agent_speech') continue;
    const d = desiredOutcome(snap.order_before, snap.call, JSON.parse(c.expected_state_json) as Expected, c.pattern_key);
    if (d.basis !== 'expected_state') continue;
    judged++;
    if (d.desired === 'ALLOW') fp++;
  }

  const reg = cases.filter((c) => c.tag === 'regression');
  let regPass = 0;
  for (const c of reg) {
    const last = one("SELECT result FROM replay_runs WHERE case_id=? AND tier='evidence' ORDER BY rowid DESC LIMIT 1", c.id);
    if (last?.result === 'pass') regPass++;
  }

  let accN = 0; let accOf = 0;
  for (const s of all('SELECT id, intent_json FROM sessions WHERE intent_json IS NOT NULL AND ended_at IS NOT NULL')) {
    accOf++;
    const intent = JSON.parse(s.intent_json) as { items: { item_id: string; quantity: number; modifiers?: string[] }[] };
    const o = store.getOrder(s.id);
    const canon = (l: { item_id: string; quantity: number; modifiers?: readonly string[] }[]) => JSON.stringify([...l].map((x) => ({ i: x.item_id, q: x.quantity, m: [...(x.modifiers ?? [])].sort() })).sort((a, b) => (a.i < b.i ? -1 : 1)));
    if (o && canon(o.state.lines) === canon(intent.items)) accN++;
  }

  return {
    generated_from: 'stored rows', latency_basis: 'client-observed',
    stages: { stt: stats(stt), gate: stats(gate), repair: stats(repair), commit: stats(commit), first_audio: stats(firstAudio), barge_in: stats(barge) },
    counts: {
      sessions: one('SELECT count(*) n FROM sessions').n, ended_sessions: one('SELECT count(*) n FROM sessions WHERE ended_at IS NOT NULL').n,
      gated_calls: gated.length, allowed: gated.length - held, held_or_conflict: held, cases: cases.length,
      regression_candidates: cases.filter((c) => c.tag === 'regression_candidate').length, regressions: reg.length, replay_runs: one('SELECT count(*) n FROM replay_runs').n,
    },
    rates: {
      conflict_rate: rate(held, gated.length),
      repair_success_rate: rate(repairOk, withRepair.length),
      false_positive_rate: { ...rate(fp, judged), note: `over ${judged} judged hold(s) (cases with a validated expected state); holds that were never judged are not counted` },
      regression_pass_rate: rate(regPass, reg.length),
      final_order_accuracy: { ...rate(accN, accOf), note: `over ${accOf} ended session(s) with a declared intent; sessions without one are not counted` },
    },
  };
}
