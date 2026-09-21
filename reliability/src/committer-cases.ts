// Step 7: case persistence. Lives beside the committer because it writes (rule 8: one write path); it receives the committer's
// own database handle and is called only from Store (committer.ts), in the SAME transaction as the hold and its repair record.
// A case is a stored, replayable failure: no case exists without stored audio AND stored events (no seeded rows, ever).
import { randomUUID } from 'node:crypto';
import type { Db } from '@tally/db';

export type CaseResolution = 'open' | 'resolved' | 'escalated' | 'unresolved_at_hangup' | 'no_repair';
export type SkipReason = 'replay_session' | 'no_audio' | 'no_events';

export interface CaseRequest {
  session_id: string; tool_call_id: string; aai_call_id: string; tool: string; args: unknown; code: string; detail: string; evidence: unknown;
  pattern_key: string; up_to_ms: number; t_received_ms?: number; threshold: number; resolution: CaseResolution;
  /** the gate checked that the recording exists on disk (the store does no file I/O) */
  audio_exists: boolean; order_before: unknown;
}
export type CaseOutcome = { ok: true; case_id: string; tag: string; pattern_count: number; flipped: boolean } | { ok: false; reason: SkipReason };

export interface CaseRow {
  id: string; session_id: string; tool_call_id: string; audio_pointer: string; transcript_snapshot: string; conflict_type: string; created_at: number;
  tag: 'none' | 'regression_candidate' | 'regression'; pattern_key: string; event_snapshot_json: string; expected_state_json: string | null;
  origin_mode: 'live' | 'demo'; resolution: CaseResolution; accepted_by: string | null;
}

const LOGGED_KINDS_NEEDED = 1;

export function insertCase(db: Db, r: CaseRequest): CaseOutcome {
  const s = db.prepare('SELECT mode, audio_pointer FROM sessions WHERE id=?').get(r.session_id) as { mode: string; audio_pointer: string | null } | undefined;
  if (!s || s.mode === 'replay') return { ok: false, reason: 'replay_session' };          // a replay never spawns cases (no recursion, rule 7)
  if (!s.audio_pointer || !r.audio_exists) return { ok: false, reason: 'no_audio' };
  const rows = db.prepare('SELECT id, type, payload_json, t_ms, audio_offset_ms, server_ts_ms FROM events_raw WHERE session_id=? AND t_ms<=? ORDER BY t_ms, rowid').all(r.session_id, r.up_to_ms) as
    { id: string; type: string; payload_json: string; t_ms: number; audio_offset_ms: number; server_ts_ms: number | null }[];
  if (rows.length < LOGGED_KINDS_NEEDED) return { ok: false, reason: 'no_events' };
  // normalised events only: the wire `raw` payload is not needed to replay through ingest -> extract -> gate, and can be large
  const events = rows.map((e) => { const { raw: _raw, ...p } = JSON.parse(e.payload_json) as Record<string, unknown>; return p; });
  const transcript = (db.prepare('SELECT speaker, source, text FROM utterances WHERE session_id=? AND is_partial=0 AND t_ms<=? ORDER BY t_ms, rowid').all(r.session_id, r.up_to_ms) as { speaker: string; source: string; text: string }[])
    .map((u) => `${u.speaker}${u.source === 'independent_stt' ? ' (independent stream)' : ''}: ${u.text}`).join('\n');
  const snapshot = {
    version: 1, session_id: r.session_id, aai_call_id: r.aai_call_id,
    call: { tool: r.tool, args: r.args, t_received_ms: r.t_received_ms ?? null },
    verdict: { code: r.code, detail: r.detail, evidence: r.evidence },
    order_before: r.order_before,
    audio: { pointer: s.audio_pointer, offset_ms_at_call: rows[rows.length - 1]!.audio_offset_ms },
    events,
  };
  const id = `case_${randomUUID()}`;
  db.prepare(
    `INSERT INTO cases(id,session_id,tool_call_id,audio_pointer,transcript_snapshot,conflict_type,created_at,tag,pattern_key,event_snapshot_json,expected_state_json,origin_mode,resolution)
     VALUES(?,?,?,?,?,?,?,'none',?,?,NULL,?,?)`,
  ).run(id, r.session_id, r.tool_call_id, s.audio_pointer, transcript, r.code, Date.now(), r.pattern_key, JSON.stringify(snapshot), s.mode, r.resolution);
  // TAGGER: when the pattern reaches the threshold, every case of the pattern becomes a regression candidate (the SAME failure, repeated)
  const count = (db.prepare('SELECT count(*) n FROM cases WHERE pattern_key=?').get(r.pattern_key) as { n: number }).n;
  let flipped = false;
  if (count >= r.threshold) {
    flipped = db.prepare("UPDATE cases SET tag='regression_candidate' WHERE pattern_key=? AND tag='none'").run(r.pattern_key).changes > 0;
  }
  const tag = (db.prepare('SELECT tag FROM cases WHERE id=?').get(id) as { tag: string }).tag;
  return { ok: true, case_id: id, tag, pattern_count: count, flipped };
}

/** Repairs resolved by a re-validated commit: the case gets its expected state = the order the gate just validated (only then). */
export function markCasesResolved(db: Db, tool_call_ids: string[], expected: { state: unknown; total_cents: number; resolving_tool_call_id: string | null }): void {
  if (!tool_call_ids.length) return;
  const q = db.prepare("UPDATE cases SET resolution='resolved', expected_state_json=? WHERE tool_call_id=? AND expected_state_json IS NULL");
  for (const id of tool_call_ids) q.run(JSON.stringify({ ...expected, derived_from: 'resolved_repair' }), id);
}

export function markCasesEscalated(db: Db, session_id: string, scope: string): void {
  db.prepare("UPDATE cases SET resolution='escalated' WHERE resolution='open' AND tool_call_id IN (SELECT tool_call_id FROM repair_events WHERE session_id=? AND scope=? AND outcome='escalated')").run(session_id, scope);
}

/** Hangup: a dispute still open becomes a pending case for review. It has NO expected state and cannot become a regression. */
export function markUnresolvedAtHangup(db: Db, session_id: string): number {
  return db.prepare("UPDATE cases SET resolution='unresolved_at_hangup' WHERE session_id=? AND resolution='open'").run(session_id).changes;
}

export type AcceptResult = { ok: true } | { ok: false; reason: 'not_found' | 'not_a_candidate' | 'no_expected_state' | 'not_resolved' };

/** candidate -> regression, only with a validated expected state from a RESOLVED repair (PRD Step 7). */
export function acceptRegression(db: Db, case_id: string, actor: 'operator' | 'auto'): AcceptResult {
  const c = db.prepare('SELECT session_id, tag, expected_state_json, resolution FROM cases WHERE id=?').get(case_id) as { session_id: string; tag: string; expected_state_json: string | null; resolution: string } | undefined;
  if (!c) return { ok: false, reason: 'not_found' };
  if (c.tag !== 'regression_candidate') return { ok: false, reason: 'not_a_candidate' };
  if (c.resolution !== 'resolved') return { ok: false, reason: 'not_resolved' };
  if (!c.expected_state_json) return { ok: false, reason: 'no_expected_state' };
  db.transaction(() => {
    db.prepare("UPDATE cases SET tag='regression', accepted_by=? WHERE id=?").run(actor, case_id);
    db.prepare('INSERT INTO audit_events(id,session_id,actor,action,before_state,after_state,timestamp,tool_call_id,validation_event_id) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(`aud_${randomUUID()}`, c.session_id, actor === 'operator' ? 'operator' : 'plane2', 'accept_regression', null, JSON.stringify({ case_id }), Date.now(), null, null);
  })();
  return { ok: true };
}

export interface CaseSummary { id: string; session_id: string; tool_call_id: string; conflict_type: string; pattern_key: string; tag: string; resolution: string; created_at: number; origin_mode: string }

export function listCases(db: Db, f: { session_id?: string; tag?: string } = {}): CaseSummary[] {
  const where: string[] = []; const args: string[] = [];
  if (f.session_id) { where.push('session_id=?'); args.push(f.session_id); }
  if (f.tag) { where.push('tag=?'); args.push(f.tag); }
  return db.prepare(`SELECT id,session_id,tool_call_id,conflict_type,pattern_key,tag,resolution,created_at,origin_mode FROM cases ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at, rowid`).all(...args) as CaseSummary[];
}

export function getCase(db: Db, id: string): CaseRow | undefined {
  return db.prepare('SELECT * FROM cases WHERE id=?').get(id) as CaseRow | undefined;
}

/** Counters for the live "cases" and "regressions" chips. `patterns_flipped` is the number of distinct patterns that reached the threshold. */
export function caseCounts(db: Db): { cases: number; candidates: number; regressions: number; patterns_flipped: number } {
  const n = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  return {
    cases: n('SELECT count(*) n FROM cases'),
    candidates: n("SELECT count(*) n FROM cases WHERE tag='regression_candidate'"),
    regressions: n("SELECT count(*) n FROM cases WHERE tag='regression'"),
    patterns_flipped: n("SELECT count(DISTINCT pattern_key) n FROM cases WHERE tag IN ('regression_candidate','regression')"),
  };
}
