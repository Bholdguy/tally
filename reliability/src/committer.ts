import { acceptRegression, caseCounts, getCase, insertCase, listCases, markCasesEscalated, markCasesResolved, markUnresolvedAtHangup, type AcceptResult, type CaseRow, type CaseSummary } from './committer-cases.js';
import { computeTotalCents } from '@tally/contract';
import { randomUUID } from 'node:crypto';
import * as cfg from './committer-configs.js';
import { openCommitter, openReadonly, type Db } from '@tally/db';
import type { AllowDecision } from './decision.js';
import { applyTool, emptyOrder, type OrderState } from './order.js';

/**
 * The single writer (ARCHITECTURE §4.2). Owns the only read-write handle; exposes narrow typed methods, never the handle.
 * An order can change only through commit(), which needs an AllowDecision and writes the audit pair in one transaction.
 */
export interface CommitRequest {
  session_id: string;
  aai_call_id: string;
  tool: string;
  args: Record<string, unknown>;
  execution_mode: 'hold' | 'interactive';
  claimed_result?: unknown;
  evidence?: unknown;
  t_received_ms?: number;
  t_verdict_ms?: number;
  /** Step 6: repairs open on these scopes are resolved IN THE SAME TRANSACTION as the commit that re-validated the call */
  resolves_scopes?: string[];
}

/** Spoken-drift repairs (Step 10) are counted, escalated and resolved SEPARATELY from hold repairs on the same scope. */
export const DRIFT_CODES = ['SPOKEN_STATE_DRIFT', 'TOTAL_MISMATCH'] as const;
const kindSql = (kind: 'hold' | 'drift') => (kind === 'drift' ? "reason IN ('SPOKEN_STATE_DRIFT','TOTAL_MISMATCH')" : "reason NOT IN ('SPOKEN_STATE_DRIFT','TOTAL_MISMATCH')");

export interface ReplayRunRow {
  id: string; case_id: string; agent_config_version: string; result: 'pass' | 'fail'; run_at: number; tier: 'evidence' | 'audio'; attempt_k: number;
  actual_state_json: string | null; diff_json: string | null; suite_run_id: string | null; duration_ms: number | null;
}

export interface RepairRow {
  id: string; session_id: string; tool_call_id: string; reason: string; repair_prompt: string; resolved_at: number | null;
  outcome: 'resolved' | 'escalated' | 'pending'; attempt: number; resolving_tool_call_id: string | null; scope: string; alt_scope: string | null;
}

export interface RepairRecord { scope: string; alt_scope?: string; attempt: number; prompt: string; outcome: 'pending' | 'escalated' }

export type CommitResult =
  | { ok: true; tool_call_id: string; state: OrderState; total_cents: number; idempotent?: true }
  | { ok: false; error_code: string; message: string };

export interface OrderRow { id: string; session_id: string; state: OrderState; total_cents: number; last_validation_event_id: string }

export class Store {
  private readonly w: Db;
  readonly r: Db; // read-only view for everyone else

  constructor(readonly path: string) {
    this.w = openCommitter(path);
    this.r = openReadonly(path);
  }

  close(): void {
    this.w.close();
    this.r.close();
  }

  createSession(p: { id: string; mode: 'live' | 'demo' | 'replay'; config_version: string; aai_session_id?: string | null; audio_pointer?: string | null }): void {
    this.w.prepare('INSERT INTO sessions(id,started_at,agent_config_version,aai_session_id,mode,audio_pointer) VALUES(?,?,?,?,?,?)')
      .run(p.id, Date.now(), p.config_version, p.aai_session_id ?? null, p.mode, p.audio_pointer ?? null);
  }

  /** Opens the (single) order for a session. Audited like any other change (validation id `open:<session>`). */
  openOrder(session_id: string): string {
    const id = `ord_${randomUUID()}`;
    const vid = `open:${session_id}`;
    this.w.transaction(() => {
      this.w.prepare('INSERT INTO audit_events(id,session_id,actor,action,before_state,after_state,timestamp,validation_event_id) VALUES(?,?,?,?,?,?,?,?)')
        .run(`aud_${randomUUID()}`, session_id, 'plane2', 'order_opened', null, JSON.stringify(emptyOrder()), Date.now(), vid);
      this.w.prepare('INSERT INTO orders(id,session_id,items_json,total,status,updated_at,last_validation_event_id) VALUES(?,?,?,?,?,?,?)')
        .run(id, session_id, '[]', 0, 'open', Date.now(), vid);
    })();
    return id;
  }

  /** Lossless evidence store: everything else is derivable from it. Idempotent per event id (replay-safe). */
  insertEventRaw(e: { id: string; session_id: string; direction: 'in' | 'out'; type: string; payload: unknown; t_ms: number; audio_offset_ms?: number; server_ts_ms?: number | null }): void {
    this.w.prepare('INSERT OR IGNORE INTO events_raw(id,session_id,direction,type,payload_json,t_ms,ts,audio_offset_ms,server_ts_ms) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(e.id, e.session_id, e.direction, e.type, JSON.stringify(e.payload), e.t_ms, Date.now(), e.audio_offset_ms ?? 0, e.server_ts_ms ?? null);
  }

  insertUtterance(u: {
    id: string; session_id: string; speaker: 'user' | 'agent'; text: string; is_partial: boolean; confidence?: number | null;
    t_ms: number; audio_offset_ms: number; item_id?: string | null; reply_id?: string | null; interrupted?: boolean | null;
    instability?: number | null; source: 'agent_stream' | 'independent_stt'; server_ts_ms?: number | null; words_json?: string | null;
  }): void {
    this.w.prepare(
      `INSERT OR IGNORE INTO utterances(id,session_id,speaker,text,is_partial,confidence,timestamp,t_ms,audio_offset_ms,item_id,reply_id,interrupted,instability,source,server_ts_ms,words_json)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(u.id, u.session_id, u.speaker, u.text, u.is_partial ? 1 : 0, u.confidence ?? null, Date.now(), u.t_ms, u.audio_offset_ms, u.item_id ?? null, u.reply_id ?? null,
      u.interrupted === undefined || u.interrupted === null ? null : u.interrupted ? 1 : 0, u.instability ?? null, u.source, u.server_ts_ms ?? null, u.words_json ?? null);
  }

  insertVad(v: { id: string; session_id: string; type: 'speech_start' | 'speech_end' | 'barge_in'; t_ms: number; derived: boolean; source_event_ids?: string[]; source: 'agent' | 'local' | 'independent' | 'derived'; reaction_ms?: number | null }): void {
    this.w.prepare('INSERT OR IGNORE INTO vad_events(id,session_id,type,timestamp,t_ms,derived,source_event_ids,source,reaction_ms) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(v.id, v.session_id, v.type, Date.now(), v.t_ms, v.derived ? 1 : 0, JSON.stringify(v.source_event_ids ?? []), v.source, v.reaction_ms ?? null);
  }

  /** Every entity carries the utterance that produced it (provenance, rule 2): source_utterance_id is NOT NULL and a foreign key. */
  insertEntity(e: { id: string; session_id: string; type: 'item' | 'quantity' | 'modifier' | 'removal' | 'substitution' | 'total' | 'pickup_time'; value: string; source_utterance_id: string; item_ref?: string | null; cue?: string | null }): void {
    this.w.prepare('INSERT OR IGNORE INTO entities(id,session_id,type,value,extracted_at,source_utterance_id,item_ref,cue) VALUES(?,?,?,?,?,?,?,?)')
      .run(e.id, e.session_id, e.type, e.value, Date.now(), e.source_utterance_id, e.item_ref ?? null, e.cue ?? null);
  }

  supersedeEntity(id: string, by: string): void {
    this.w.prepare('UPDATE entities SET superseded_by=? WHERE id=? AND superseded_by IS NULL').run(by, id);
  }

  endSession(session_id: string): void {
    this.w.transaction(() => {
      this.w.prepare('UPDATE sessions SET ended_at=? WHERE id=? AND ended_at IS NULL').run(Date.now(), session_id);
      // hangup: disputes still open become pending cases (no expected state, cannot become regressions)
      markUnresolvedAtHangup(this.w, session_id);
    })();
  }

  /** The order the speaker intended, declared up front (never derived from a transcript or the system's behaviour). */
  setIntent(session_id: string, intent: unknown): void {
    this.w.prepare('UPDATE sessions SET intent_json=? WHERE id=?').run(JSON.stringify(intent), session_id);
  }

  setAudioPointer(session_id: string, pointer: string): void {
    this.w.prepare('UPDATE sessions SET audio_pointer=? WHERE id=?').run(pointer, session_id);
  }

  setAaiSessionId(session_id: string, aai: string | null): void {
    this.w.prepare('UPDATE sessions SET aai_session_id=? WHERE id=?').run(aai, session_id);
  }

  getOrder(session_id: string): OrderRow | undefined {
    return readOrder(this.r, session_id);
  }

  /** A previously decided call (idempotency + the gate's replay of an already-recorded verdict). */
  getToolCall(session_id: string, aai_call_id: string): { id: string; status: 'allowed' | 'held' | 'conflict'; conflict_type: string | null; validation_event_id: string } | undefined {
    return this.r.prepare('SELECT id,status,conflict_type,validation_event_id FROM tool_calls WHERE session_id=? AND aai_call_id=?').get(session_id, aai_call_id) as
      | { id: string; status: 'allowed' | 'held' | 'conflict'; conflict_type: string | null; validation_event_id: string } | undefined;
  }

  /**
   * Record a call the gate did NOT allow (held / conflict). Writes a tool_calls row and an audit row and NOTHING ELSE:
   * `orders` is never touched, so a held call cannot change state. Idempotent per (session, aai_call_id).
   */
  recordHold(p: {
    session_id: string; aai_call_id: string; tool: string; args: unknown; execution_mode: 'hold' | 'interactive';
    status: 'held' | 'conflict'; code: string; detail: string; evidence: unknown; validation_event_id: string;
    t_received_ms?: number; t_verdict_ms?: number;
    /** Step 6: written in the SAME transaction as the hold, so a hold and its repair record cannot disagree */
    repair?: RepairRecord;
    /** Step 7: the failure snapshot, stored in the same transaction (skipped, and audited, when there is no stored audio or events) */
    case?: { pattern_key: string; threshold: number; audio_exists: boolean; up_to_ms: number };
  }): string {
    return this.w.transaction((): string => {
      const prior = this.w.prepare('SELECT id FROM tool_calls WHERE session_id=? AND aai_call_id=?').get(p.session_id, p.aai_call_id) as { id: string } | undefined;
      if (prior) return prior.id;
      const id = `tc_${randomUUID()}`;
      const row = readOrder(this.w, p.session_id);
      const now = Date.now();
      this.w.prepare(
        `INSERT INTO tool_calls(id,session_id,tool_name,args_json,claimed_result_json,actual_result_json,status,timestamp,aai_call_id,conflict_type,evidence_json,state_diff_json,validation_event_id,execution_mode,t_received_ms,t_verdict_ms)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(id, p.session_id, p.tool, JSON.stringify(p.args ?? null), JSON.stringify({ arguments: p.args ?? null }), null, p.status, now, p.aai_call_id, p.code,
        JSON.stringify({ ...(p.evidence as object), detail: p.detail }), null, p.validation_event_id, p.execution_mode, p.t_received_ms ?? null, p.t_verdict_ms ?? null);
      const snap = row ? JSON.stringify(row.state) : null;
      this.w.prepare('INSERT INTO audit_events(id,session_id,actor,action,before_state,after_state,timestamp,tool_call_id,validation_event_id) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(`aud_${randomUUID()}`, p.session_id, 'plane2', `${p.status}:${p.tool}:${p.code}`, snap, snap, now, id, p.validation_event_id);
      if (p.repair) {
        // an escalation closes the ask-loop for the scope: earlier pending asks become 'escalated' too (history stays in the table)
        if (p.repair.outcome === 'escalated') {
          this.w.prepare(`UPDATE repair_events SET outcome='escalated' WHERE session_id=? AND scope=? AND resolved_at IS NULL AND outcome='pending' AND ${kindSql((DRIFT_CODES as readonly string[]).includes(p.code) ? 'drift' : 'hold')}`).run(p.session_id, p.repair.scope);
        }
        this.w.prepare('INSERT INTO repair_events(id,session_id,tool_call_id,reason,repair_prompt,outcome,attempt,scope,alt_scope) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(`rep_${randomUUID()}`, p.session_id, id, p.code, p.repair.prompt, p.repair.outcome, p.repair.attempt, p.repair.scope, p.repair.alt_scope ?? null);
      }
      if (p.case) {
        const out = insertCase(this.w, {
          session_id: p.session_id, tool_call_id: id, aai_call_id: p.aai_call_id, tool: p.tool, args: p.args, code: p.code, detail: p.detail, evidence: p.evidence,
          pattern_key: p.case.pattern_key, up_to_ms: p.case.up_to_ms, t_received_ms: p.t_received_ms, threshold: p.case.threshold, audio_exists: p.case.audio_exists,
          order_before: row?.state ?? null,
          resolution: !p.repair ? 'no_repair' : p.repair.outcome === 'escalated' ? 'escalated' : 'open',
        });
        if (!out.ok) {
          // never silent: a hold that could not become a replayable case says why
          this.w.prepare('INSERT INTO audit_events(id,session_id,actor,action,before_state,after_state,timestamp,tool_call_id,validation_event_id) VALUES(?,?,?,?,?,?,?,?,?)')
            .run(`aud_${randomUUID()}`, p.session_id, 'plane2', `case_skipped:${out.reason}`, null, JSON.stringify({ pattern_key: p.case.pattern_key }), now, id, p.validation_event_id);
        }
        if (p.repair?.outcome === 'escalated') markCasesEscalated(this.w, p.session_id, p.repair.scope);
      }
      return id;
    })();
  }

  /** Open (unresolved) repair state for one scope: how many asks are pending, and whether it is escalated. */
  repairState(session_id: string, scope: string, kind: 'hold' | 'drift' = 'hold'): { pending: number; escalated: boolean } {
    const rows = this.w.prepare(`SELECT outcome, count(*) n FROM repair_events WHERE session_id=? AND resolved_at IS NULL AND (scope=? OR alt_scope=?) AND ${kindSql(kind)} GROUP BY outcome`).all(session_id, scope, scope) as { outcome: string; n: number }[];
    return { pending: rows.find((r) => r.outcome === 'pending')?.n ?? 0, escalated: rows.some((r) => r.outcome === 'escalated') };
  }

  /** Repairs still open (pending or escalated-and-unresolved) for a session, oldest first. */
  openRepairs(session_id: string): RepairRow[] {
    return this.w.prepare('SELECT * FROM repair_events WHERE session_id=? AND resolved_at IS NULL ORDER BY rowid').all(session_id) as RepairRow[];
  }

  allRepairs(session_id: string): RepairRow[] {
    return this.w.prepare('SELECT * FROM repair_events WHERE session_id=? ORDER BY rowid').all(session_id) as RepairRow[];
  }

  /**
   * Step 10: the agent's LATER speech stated this scope correctly, so an open spoken-drift repair on it is resolved. Only drift repairs:
   * agent speech never resolves a hold dispute (that needs a re-validated call). The case's expected state is the committed order.
   */
  resolveDriftRepairs(session_id: string, scopes: string[]): number {
    return this.w.transaction(() => {
      const row = readOrder(this.w, session_id);
      return this.resolveRepairsIn(session_id, scopes, null, Date.now(), row ? { state: row.state, total_cents: row.total_cents } : undefined, 'drift');
    })();
  }

  /** Scopes with an open (unresolved, not escalated-and-closed) spoken-drift repair. */
  openDriftScopes(session_id: string): string[] {
    return (this.w.prepare("SELECT DISTINCT scope FROM repair_events WHERE session_id=? AND resolved_at IS NULL AND reason IN ('SPOKEN_STATE_DRIFT','TOTAL_MISMATCH')").all(session_id) as { scope: string }[]).map((r) => r.scope);
  }

  /** Resolve open repairs on these scopes WITHOUT a commit (an exact-repeat ALLOW wrote nothing). Returns the scopes' rows resolved. */
  resolveRepairs(session_id: string, scopes: string[]): number {
    return this.w.transaction(() => {
      const row = readOrder(this.w, session_id);
      return this.resolveRepairsIn(session_id, scopes, null, Date.now(), row ? { state: row.state, total_cents: row.total_cents } : undefined);
    })();
  }

  /** A repair is resolved ONLY by a re-validated call. An escalated row keeps outcome='escalated' (the history) and gets resolved_at. */
  private resolveRepairsIn(session_id: string, scopes: string[], resolving_tool_call_id: string | null, now: number, after?: { state: unknown; total_cents: number }, kind: 'hold' | 'drift' = 'hold'): number {
    let n = 0;
    const resolvedCalls: string[] = [];
    for (const s of scopes) {
      const open = this.w.prepare(`SELECT id, outcome, tool_call_id FROM repair_events WHERE session_id=? AND resolved_at IS NULL AND (scope=? OR alt_scope=?) AND ${kindSql(kind)}`).all(session_id, s, s) as { id: string; outcome: string; tool_call_id: string }[];
      for (const r of open) {
        if (r.outcome === 'pending') resolvedCalls.push(r.tool_call_id);
        this.w.prepare("UPDATE repair_events SET resolved_at=?, resolving_tool_call_id=?, outcome=CASE WHEN outcome='pending' THEN 'resolved' ELSE outcome END WHERE id=?").run(now, resolving_tool_call_id, r.id);
        n++;
      }
    }
    if (after) markCasesResolved(this.w, resolvedCalls, { ...after, resolving_tool_call_id });
    return n;
  }

  sessionAudio(session_id: string): { pointer: string | null; mode: 'live' | 'demo' | 'replay' } | undefined {
    const r = this.w.prepare('SELECT audio_pointer, mode FROM sessions WHERE id=?').get(session_id) as { audio_pointer: string | null; mode: 'live' | 'demo' | 'replay' } | undefined;
    return r ? { pointer: r.audio_pointer, mode: r.mode } : undefined;
  }

  /** Step 7 reads and the operator acceptance. `acceptRegression` is the ONLY way a case becomes tag=regression. */
  caseByToolCall(tool_call_id: string): (CaseRow & { pattern_count: number }) | undefined {
    const c = this.w.prepare('SELECT * FROM cases WHERE tool_call_id=?').get(tool_call_id) as CaseRow | undefined;
    if (!c) return undefined;
    return { ...c, pattern_count: (this.w.prepare('SELECT count(*) n FROM cases WHERE pattern_key=?').get(c.pattern_key) as { n: number }).n };
  }
  getCase(id: string): CaseRow | undefined { return getCase(this.w, id); }
  listCases(f: { session_id?: string; tag?: string } = {}): CaseSummary[] { return listCases(this.w, f); }
  caseCounts(): ReturnType<typeof caseCounts> { return caseCounts(this.w); }
  acceptRegression(case_id: string, actor: 'operator' | 'auto'): AcceptResult { return acceptRegression(this.w, case_id, actor); }

  /**
   * REPLAY FIXTURE ONLY (Step 8). Puts a replay session's order into the state the original case saw, so the current gate can be
   * re-run against the recorded call. Hard-guarded: it refuses any session that is not mode='replay', so it can never touch a live
   * or demo order; it writes the same audit pairing as every other order change. It is the only order write that is not a gate ALLOW.
   */
  seedReplayOrder(session_id: string, state: OrderState): void {
    this.w.transaction(() => {
      const s = this.w.prepare('SELECT mode FROM sessions WHERE id=?').get(session_id) as { mode: string } | undefined;
      if (!s || s.mode !== 'replay') throw new Error('seedReplayOrder refused: not a replay session');
      const row = readOrder(this.w, session_id);
      if (!row) throw new Error('seedReplayOrder refused: session has no order');
      const vid = `replay_seed:${session_id}:${randomUUID()}`;      // a fresh id per seed: the orders trigger requires every change to carry a NEW validation id
      const now = Date.now();
      this.w.prepare('INSERT INTO audit_events(id,session_id,actor,action,before_state,after_state,timestamp,validation_event_id) VALUES(?,?,?,?,?,?,?,?)')
        .run(`aud_${randomUUID()}`, session_id, 'plane2', 'replay_seed', JSON.stringify(row.state), JSON.stringify(state), now, vid);
      this.w.prepare('UPDATE orders SET items_json=?, total=?, status=?, pickup_time=?, updated_at=?, last_validation_event_id=? WHERE id=?')
        .run(JSON.stringify(state.lines), computeTotalCents(state.lines), state.status, state.pickup_time, now, vid, row.id);
    })();
  }

  recordReplayRun(p: { case_id: string; config_version: string; result: 'pass' | 'fail'; tier: 'evidence' | 'audio'; attempt_k: number; actual_state_json: string | null; diff_json: string; suite_run_id?: string | null; duration_ms?: number | null }): string {
    const id = `rr_${randomUUID()}`;
    this.w.prepare('INSERT INTO replay_runs(id,case_id,agent_config_version,result,run_at,tier,attempt_k,actual_state_json,diff_json,suite_run_id,duration_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, p.case_id, p.config_version, p.result, Date.now(), p.tier, p.attempt_k, p.actual_state_json, p.diff_json, p.suite_run_id ?? null, p.duration_ms ?? null);
    return id;
  }

  listReplayRuns(case_id: string): ReplayRunRow[] {
    return this.w.prepare('SELECT * FROM replay_runs WHERE case_id=? ORDER BY rowid').all(case_id) as ReplayRunRow[];
  }

  // ---- Step 9: config registry and promotion (all rules live in committer-configs.ts) ----
  createConfig(p: Parameters<typeof cfg.createConfig>[1]): cfg.ConfigWithIntegrity { return cfg.createConfig(this.w, p); }
  getConfig(version: string): cfg.ConfigWithIntegrity | undefined { return cfg.getConfig(this.w, version); }
  activeConfig(): cfg.ConfigWithIntegrity | undefined { return cfg.activeConfig(this.w); }
  listConfigs(): cfg.ConfigWithIntegrity[] { return cfg.listConfigs(this.w); }
  activateBaseline(version: string): void { cfg.activateBaseline(this.w, version); }
  insertSuiteRun(r: cfg.SuiteRunInput): void { cfg.insertSuiteRun(this.w, r); }
  getSuiteRun(id: string): cfg.SuiteRunRow | undefined { return cfg.getSuiteRun(this.w, id); }
  currentRegressionIds(): string[] { return cfg.currentRegressionIds(this.w); }
  /** Makes a version ACTIVE. Throws ConfigError unless a passing, fresh, unconsumed suite run for exactly this version is supplied. */
  activateConfig(version: string, suite_run_id: string | undefined, actor?: string): { previous: string | null } { return cfg.activate(this.w, version, suite_run_id, actor); }
  rollbackConfig(actor?: string): { from: string; to: string } { return cfg.rollback(this.w, actor); }
  configHistory(version?: string) { return cfg.configHistory(this.w, version); }
  compareTable() { return cfg.compareTable(this.w); }

  /** Stored, normalised events of a session in arrival order (the wire `raw` payload is dropped): the dashboard's backlog and past-session view. */
  sessionEvents(session_id: string): Record<string, unknown>[] {
    return (this.w.prepare('SELECT payload_json FROM events_raw WHERE session_id=? ORDER BY t_ms, rowid').all(session_id) as { payload_json: string }[])
      .map((r) => { const { raw: _raw, ...p } = JSON.parse(r.payload_json) as Record<string, unknown>; return p; });
  }

  listSessions(): { id: string; mode: string; started_at: number; ended_at: number | null; agent_config_version: string; has_intent: boolean }[] {
    return (this.w.prepare('SELECT id, mode, started_at, ended_at, agent_config_version, intent_json IS NOT NULL AS has_intent FROM sessions ORDER BY started_at DESC, rowid DESC LIMIT 200').all() as any[])
      .map((s) => ({ ...s, has_intent: !!s.has_intent }));
  }

  /** Post-commit incident (e.g. TOOL_RESULT_LIE): flag the already-recorded call; the audit trail is append-only. */
  flagToolCall(tool_call_id: string, session_id: string, code: string, detail: string): void {
    this.w.transaction(() => {
      this.w.prepare("UPDATE tool_calls SET status='conflict', conflict_type=? WHERE id=?").run(code, tool_call_id);
      this.w.prepare('INSERT INTO audit_events(id,session_id,actor,action,before_state,after_state,timestamp,tool_call_id,validation_event_id) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(`aud_${randomUUID()}`, session_id, 'plane2', `incident:${code}`, null, JSON.stringify({ detail }), Date.now(), tool_call_id, null);
    })();
  }

  /** Non-order audit entry (e.g. spoken-drift findings). */
  appendAudit(p: { session_id: string; action: string; detail: unknown; tool_call_id?: string | null }): void {
    this.w.prepare('INSERT INTO audit_events(id,session_id,actor,action,before_state,after_state,timestamp,tool_call_id,validation_event_id) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(`aud_${randomUUID()}`, p.session_id, 'plane2', p.action, null, JSON.stringify(p.detail), Date.now(), p.tool_call_id ?? null, null);
  }

  /** Order + audit + tool_calls row in ONE transaction. Nothing is written if the projection fails. */
  commit(allow: AllowDecision, req: CommitRequest): CommitResult {
    const c0 = performance.now();
    if (allow.session_id !== req.session_id || allow.aai_call_id !== req.aai_call_id) {
      return { ok: false, error_code: 'DECISION_MISMATCH', message: 'AllowDecision does not belong to this tool call' };
    }
    try {
      return this.w.transaction((): CommitResult => {
        const row = readOrder(this.w, req.session_id);
        if (!row) return { ok: false, error_code: 'NO_ORDER', message: 'session has no order' };
        // D-20: replaying the same call_id is idempotent: return the recorded outcome, write nothing
        const prior = this.w.prepare('SELECT id FROM tool_calls WHERE session_id=? AND aai_call_id=?').get(req.session_id, req.aai_call_id) as { id: string } | undefined;
        if (prior) return { ok: true, tool_call_id: prior.id, state: row.state, total_cents: row.total_cents, idempotent: true };
        const applied = applyTool(row.state, req.tool, req.args);
        if (!applied.ok) return { ok: false, error_code: applied.error_code, message: applied.message };

        const tool_call_id = `tc_${randomUUID()}`;
        const now = Date.now();
        const diff = { before: row.state, after: applied.state, total_before_cents: row.total_cents, total_after_cents: applied.total_cents };
        this.w.prepare(
          `INSERT INTO tool_calls(id,session_id,tool_name,args_json,claimed_result_json,actual_result_json,status,timestamp,aai_call_id,evidence_json,state_diff_json,validation_event_id,execution_mode,t_received_ms,t_verdict_ms,t_commit_ms)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(tool_call_id, req.session_id, req.tool, JSON.stringify(req.args), JSON.stringify(req.claimed_result ?? null),
          JSON.stringify({ state: applied.state, total_cents: applied.total_cents }), 'allowed', now, req.aai_call_id,
          JSON.stringify(req.evidence ?? null), JSON.stringify(diff), allow.validation_event_id, req.execution_mode,
          req.t_received_ms ?? null, req.t_verdict_ms ?? null, performance.now() - c0);      // t_commit_ms = how long the commit took (ms), so p50/p95 are real durations
        // audit row FIRST: the orders trigger requires it to exist (pairing, rule 8)
        this.w.prepare('INSERT INTO audit_events(id,session_id,actor,action,before_state,after_state,timestamp,tool_call_id,validation_event_id) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(`aud_${randomUUID()}`, req.session_id, 'plane2', `commit:${req.tool}`, JSON.stringify(row.state), JSON.stringify(applied.state), now, tool_call_id, allow.validation_event_id);
        this.w.prepare('UPDATE orders SET items_json=?, total=?, status=?, pickup_time=?, updated_at=?, last_validation_event_id=? WHERE id=?')
          .run(JSON.stringify(applied.state.lines), applied.total_cents, applied.state.status, applied.state.pickup_time, now, allow.validation_event_id, row.id);
        if (req.resolves_scopes?.length) this.resolveRepairsIn(req.session_id, req.resolves_scopes, tool_call_id, now, { state: applied.state, total_cents: applied.total_cents });
        return { ok: true, tool_call_id, state: applied.state, total_cents: applied.total_cents };
      })();
    } catch (err) {
      // fail closed: any DB error means nothing was committed (transaction rolled back)
      return { ok: false, error_code: 'COMMIT_FAILED', message: err instanceof Error ? err.message : String(err) };
    }
  }
}

export function readOrder(db: Db, session_id: string): OrderRow | undefined {
  const r = db.prepare('SELECT id,session_id,items_json,total,status,pickup_time,last_validation_event_id FROM orders WHERE session_id=?').get(session_id) as
    | { id: string; session_id: string; items_json: string; total: number; status: OrderState['status']; pickup_time: string | null; last_validation_event_id: string }
    | undefined;
  if (!r) return undefined;
  const lines = JSON.parse(r.items_json) as OrderState['lines'];
  // stored total is returned as-is; the gate (Step 5) recomputes from lines and treats a disagreement as TOTAL_MISMATCH
  return { id: r.id, session_id: r.session_id, state: { lines, status: r.status, pickup_time: r.pickup_time }, total_cents: r.total, last_validation_event_id: r.last_validation_event_id };
}
