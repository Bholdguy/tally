// ACTION GATING (Step 5). Every mutating tool call passes through Gate.submit before anything can change the order.
//
//   schema → evidence-driven settle on the INDEPENDENT stream → extract → judge → projected diff → verdict → commit → read-back
//
// Design rules enforced here (brief §14):
//  1. FAIL CLOSED. `submit` is a total function: any throw, timeout, unknown, missing or unfinished evidence returns HOLD.
//     There is exactly one place that mints an ALLOW (`mintAllow`, below) and it is reached only after every check passed.
//  3. NO LLM-AS-TRUTH. Evidence is what the customer said (independent STT), extracted by deterministic rules. The agent's
//     arguments are claims to be checked; the agent's speech is checked after the fact (drift), never trusted.
//  8. MUTATION ONLY THROUGH THIS PATH. The committer needs the AllowDecision minted here.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  MAX_REPAIR_ATTEMPTS, MENU, computeTotalCents, NON_DEFINITE_CODES, escalationText, executionMode, getItem, isMutating, repairAsk, validateToolArgs,
  type ConflictCode, type GateResult, type RepairInstruction, type ToolCallRequest, type ToolName,
} from '@tally/contract';
import { systemClock, type Clock } from './clock.js';
import { mintAllow, type AllowDecision } from './decision.js';
import { derivePattern } from './cases.js';
import { checkSpokenDrift, statesScopeCorrectly, type DriftFinding } from './drift.js';
import type { EvidenceTracker } from './evidence.js';
import { extractEvidence } from './extractor.js';
import { judgeCall } from './judge.js';
import { applyTool, type OrderState } from './order.js';
import type { CommitRequest, CommitResult, RepairRecord, Store } from './committer.js';

export interface GateOptions {
  store: Store;
  evidenceFor: (session_id: string) => EvidenceTracker;
  clock?: Clock;
  /** max time to wait for the customer's speech to be finalised by the independent stream (spike A: worst measured 3470 ms) */
  evidenceWaitMaxMs?: number;
  /** quantity/item words below this confidence hold the call (spike A: word confidences 0.63-0.89) */
  minWordConfidence?: number;
  pollMs?: number;
  /** Step 6: told when a repair is asked / escalated / resolved (for the timeline and call log). Must not throw into the gate. */
  onRepair?: (r: RepairNotice) => void;
  maxRepairAttempts?: number;
  /** the gate began WAITING for the customer's speech to be finalised on the independent stream (beat 5b) */
  onWait?: (w: { aai_call_id: string; tool: string; max_ms: number; reason: string }) => void;
  /** every gated call's final verdict, for the dashboard */
  onVerdict?: (v: { req: ToolCallRequest; result: GateResult }) => void;
  /** Step 7: a case is created for every hold; the pattern tags as a regression candidate at this count (REGRESSION_THRESHOLD, default 3) */
  regressionThreshold?: number;
  /** told when a hold became a stored case (for the live counters) */
  onCase?: (c: CaseNotice) => void;
  /** test seam: whether the recording exists on disk (default: fs.existsSync) */
  audioExists?: (pointer: string) => boolean;
  /** test seams (fault injection): never set in production wiring */
  extract?: typeof extractEvidence;
  commit?: (allow: AllowDecision, req: CommitRequest) => CommitResult;
}

export interface RepairNotice { outcome: 'asked' | 'escalated' | 'resolved'; scope: string; aai_call_id?: string; code?: ConflictCode; attempt?: number; ask_text?: string }

/** longest single customer utterance the gate will validate (about 45 minutes of speech at normal pace is far below this per TURN) */
export const MAX_EVIDENCE_CHARS = 20000;

export interface CaseNotice { case_id: string; tool_call_id: string; conflict_type: string; pattern_key: string; tag: string; pattern_count: number; resolution: string; threshold_reached: boolean }

export interface DriftOutcome { findings: DriftFinding[]; repairs: RepairInstruction[]; resolved: string[]; skipped?: 'interrupted' | 'order_changed_during_reply' }

export interface OrderView { lines: OrderState['lines']; total_cents: number; status: OrderState['status'] }

type HoldExtra = { item_id?: string; evidenced_value?: string; projection_error?: string; repairable?: boolean };

export class Gate {
  private readonly clock: Clock;
  private readonly waitMax: number;
  private readonly minConf: number;
  private readonly poll: number;
  private readonly extract: typeof extractEvidence;

  constructor(private readonly o: GateOptions) {
    this.clock = o.clock ?? systemClock;
    this.waitMax = o.evidenceWaitMaxMs ?? 4500;
    this.minConf = o.minWordConfidence ?? 0.6;
    this.poll = o.pollMs ?? 25;
    this.extract = o.extract ?? extractEvidence;
  }

  /** Read-only order view for Plane 1's get_order_state (never gated, never writes). */
  readState(session_id: string): OrderView | undefined {
    const r = this.o.store.getOrder(session_id);
    return r ? { lines: r.state.lines, total_cents: r.total_cents, status: r.state.status } : undefined;
  }

  /** Version stamp of the committed order (the last validation event id): changes on every order change. */
  orderVersion(session_id: string): string | null {
    return this.o.store.getOrder(session_id)?.last_validation_event_id ?? null;
  }

  /** Back-compat detection-only view: the findings, with the same audit rows. Prefer handleAgentSpeech. */
  onAgentSpeech(session_id: string, text: string): DriftFinding[] {
    return this.handleAgentSpeech(session_id, text).findings;
  }

  /**
   * STEP 10: what the agent SAID about the order is checked against the COMMITTED order (never the reverse, rule 3).
   * A disagreement becomes a scoped spoken-drift repair (attempt counter, escalation, case), returned as DATA for Plane 1 to speak;
   * a later utterance that states the scope correctly resolves it. Speech never changes the order and never resolves a hold dispute.
   *  - `order_version`: the order version when the reply STARTED. If the order changed during the reply the statement is ambiguous
   *    (it may have been true when spoken), so nothing is raised: a wrong "correction" would confuse the customer more than a miss.
   *  - interrupted replies are partial; they are skipped.
   */
  handleAgentSpeech(session_id: string, text: string, ctx: { order_version?: string | null; interrupted?: boolean; utterance_id?: string } = {}): DriftOutcome {
    const out: DriftOutcome = { findings: [], repairs: [], resolved: [] };
    const r = this.o.store.getOrder(session_id);
    if (!r) return out;
    const view = { lines: r.state.lines, total_cents: r.total_cents };
    const findings = checkSpokenDrift(text, view);
    out.findings = findings;
    for (const f of findings) this.o.store.appendAudit({ session_id, action: `drift:${f.code}`, detail: { ...f, spoken: text } });

    if (ctx.interrupted) { if (findings.length) { out.skipped = 'interrupted'; this.audit(session_id, 'drift_skipped:interrupted', text); } return out; }
    if (ctx.order_version !== undefined && ctx.order_version !== r.last_validation_event_id) {
      if (findings.length) { out.skipped = 'order_changed_during_reply'; this.audit(session_id, 'drift_skipped:order_changed_during_reply', text); }
      return out;
    }

    // resolution: this utterance states an open drift scope correctly
    const drifted = new Set(findings.map((f) => f.item_id ?? 'order'));
    const open = this.o.store.openDriftScopes(session_id).filter((s) => !drifted.has(s) && statesScopeCorrectly(text, view, s));
    if (open.length) {
      this.o.store.resolveDriftRepairs(session_id, open);
      for (const s of open) { out.resolved.push(s); this.notify({ outcome: 'resolved', scope: s }); }
    }

    const max = this.o.maxRepairAttempts ?? MAX_REPAIR_ATTEMPTS;
    const seen = new Set<string>();
    for (const f of findings) {
      const scope = f.item_id ?? 'order';
      if (seen.has(scope)) continue;
      seen.add(scope);
      const callId = `speech:${ctx.utterance_id ?? `${session_id}:${text.length}:${text.slice(0, 24)}`}:${scope}`;
      if (this.o.store.getToolCall(session_id, callId)) continue;                       // the same utterance is never raised twice
      const st = this.o.store.repairState(session_id, scope, 'drift');
      if (st.escalated) { this.audit(session_id, 'drift_after_escalation', text); continue; }   // we already handed off: no further corrections
      const attempt = st.pending + 1;
      const escalated = attempt > max;
      const line = view.lines.find((l) => l.item_id === f.item_id);
      const value = f.code === 'TOTAL_MISMATCH' ? `$${((f.actual_total_cents ?? r.total_cents) / 100).toFixed(2)}` : line ? String(line.quantity) : 'not_on_order';
      const ctxr = { item_id: f.item_id, evidenced_value: value };
      const ask_text = escalated ? escalationText(ctxr) : repairAsk(f.code, ctxr);
      const instruction: RepairInstruction = { aai_call_id: callId, code: f.code, item_id: f.item_id, evidenced_value: value, ask_text, attempt: escalated ? max + 1 : attempt, ...(escalated ? { escalated: true } : {}) };
      const vid = `val_${randomUUID()}`;
      const now = this.clock.now();
      const pattern = derivePattern({ code: f.code, tool: 'agent_speech', item_id: f.item_id, utterances: [], detail: f.detail });
      const audio = (() => { try { return this.o.store.sessionAudio(session_id); } catch { return undefined; } })();
      const exists = this.o.audioExists ?? existsSync;
      try {
        // the spoken claim is recorded like any other disputed claim: a tool_calls row (tool "agent_speech"), its repair record and its case
        const tcId = this.o.store.recordHold({
          session_id, aai_call_id: callId, tool: 'agent_speech', args: { text, finding: f.detail, item_id: f.item_id ?? null }, execution_mode: 'interactive', status: 'conflict', code: f.code, detail: f.detail,
          evidence: { spoken: text, order: view }, validation_event_id: vid, t_received_ms: now, t_verdict_ms: now,
          repair: { scope, attempt: instruction.attempt, prompt: ask_text, outcome: escalated ? 'escalated' : 'pending' },
          case: { pattern_key: pattern.key, threshold: this.o.regressionThreshold ?? 3, up_to_ms: now, audio_exists: !!audio?.pointer && exists(audio.pointer) },
        });
        const c = this.o.store.caseByToolCall(tcId);
        if (c) { try { this.o.onCase?.({ case_id: c.id, tool_call_id: tcId, conflict_type: c.conflict_type, pattern_key: c.pattern_key, tag: c.tag, pattern_count: c.pattern_count, resolution: c.resolution, threshold_reached: c.pattern_count >= (this.o.regressionThreshold ?? 3) }); } catch { /* observer */ } }
      } catch { /* recording failed: the correction is still returned, nothing was written to orders */ }
      out.repairs.push(instruction);
      this.notify({ outcome: escalated ? 'escalated' : 'asked', scope, aai_call_id: callId, code: f.code, attempt: instruction.attempt, ask_text });
    }
    return out;
  }

  private audit(session_id: string, action: string, text: string): void {
    try { this.o.store.appendAudit({ session_id, action, detail: { spoken: text } }); } catch { /* audit is best effort here */ }
  }

  async submit(req: ToolCallRequest): Promise<GateResult> {
    const t0 = this.clock.now();
    const vid = `val_${randomUUID()}`;
    let result: GateResult;
    try {
      result = await this.decide(req, vid, t0);
    } catch (err) {
      // TOTAL FUNCTION: whatever went wrong, the answer is HOLD, never ALLOW.
      result = this.hold(req, vid, t0, 'UNVALIDATABLE', `gate error: ${err instanceof Error ? err.message : String(err)}`, {}, {});
    }
    try { this.o.onVerdict?.({ req, result }); } catch { /* an observer must never affect a verdict */ }
    return result;
  }

  private async decide(req: ToolCallRequest, vid: string, t0: number): Promise<GateResult> {
    const { store } = this.o;

    // 0. idempotency: the same call id is never decided twice
    const prior = store.getToolCall(req.session_id, req.aai_call_id);
    if (prior) {
      if (prior.status === 'allowed') {
        const cur = this.readState(req.session_id);
        return { verdict: 'ALLOW', validation_event_id: prior.validation_event_id, actual_result: cur ?? null, noop: true };
      }
      return { verdict: 'HOLD', code: (prior.conflict_type as ConflictCode | null) ?? 'UNVALIDATABLE', validation_event_id: prior.validation_event_id, detail: 'replay of an earlier decision for this call id' };
    }

    // 1. gated tools only
    if (!isMutating(req.tool)) return this.hold(req, vid, t0, 'SCHEMA_INVALID', `${req.tool} is not a gated tool`, {}, { projection_error: 'not_gated' });

    const row = store.getOrder(req.session_id);
    if (!row) return this.hold(req, vid, t0, 'UNVALIDATABLE', 'session has no order', {}, {});

    // 2. schema. order_id is Plane 1's business: any model-supplied value is discarded and replaced with the real one.
    const rawArgs = (typeof req.args === 'object' && req.args !== null ? { ...(req.args as Record<string, unknown>) } : {}) as Record<string, unknown>;
    if (req.tool === 'confirm_order') rawArgs.order_id = row.id;
    const v = validateToolArgs(req.tool, rawArgs);
    if (!v.ok) {
      const itemId = typeof rawArgs.item_id === 'string' ? rawArgs.item_id : undefined;
      const code: ConflictCode = itemId !== undefined && !getItem(itemId) ? 'UNKNOWN_ITEM' : v.issues.some((i) => i.includes('not allowed for')) ? 'BAD_MODIFIER' : 'SCHEMA_INVALID';
      return this.hold(req, vid, t0, code, v.issues.join('; '), {}, { item_id: itemId && getItem(itemId) ? itemId : undefined });
    }
    const args = v.args;

    // 3. EVIDENCE-DRIVEN SETTLE on the independent stream (D-04). Wait only while someone is speaking.
    const tracker = this.o.evidenceFor(req.session_id);
    let snap = tracker.snapshot(this.clock.now());
    let waitAnnounced = false;
    for (;;) {
      if (snap.streamStatus !== 'up') {
        return this.hold(req, vid, t0, 'UNVALIDATABLE', `independent evidence stream is ${snap.streamStatus}${snap.streamReason ? ` (${snap.streamReason})` : ''}`, this.evSummary(snap), { item_id: args.item_id as string | undefined });
      }
      if (snap.stalled) {
        return this.hold(req, vid, t0, 'UNVALIDATABLE', `independent stream silent while speech is in flight: ${snap.reasons.join('; ')}`, this.evSummary(snap), { item_id: args.item_id as string | undefined });
      }
      if (!snap.speechInFlight) break;
      if (!waitAnnounced) { waitAnnounced = true; try { this.o.onWait?.({ aai_call_id: req.aai_call_id, tool: req.tool, max_ms: this.waitMax, reason: snap.reasons.join('; ') || 'customer still speaking' }); } catch { /* observer */ } }
      if (this.clock.now() - t0 >= this.waitMax) {
        return this.hold(req, vid, t0, 'PENDING_EVIDENCE', `customer speech not finalised within ${this.waitMax} ms: ${snap.reasons.join('; ')}`, this.evSummary(snap), { item_id: args.item_id as string | undefined });
      }
      await this.clock.sleep(this.poll);
      snap = tracker.snapshot(this.clock.now());
    }

    // 4. extract + judge
    if (snap.finals.length === 0) return this.hold(req, vid, t0, 'UNVALIDATABLE', 'no finalised customer speech to validate against', this.evSummary(snap), { item_id: args.item_id as string | undefined });
    // work bound (adversarial harness): evidence text is extracted with super-linear cost; an absurdly long "utterance" is not validated, it is held
    if (snap.finals.some((u) => u.text.length > MAX_EVIDENCE_CHARS)) return this.hold(req, vid, t0, 'UNVALIDATABLE', `customer utterance longer than ${MAX_EVIDENCE_CHARS} characters cannot be validated`, this.evSummary(snap), { item_id: args.item_id as string | undefined });
    const ev = this.extract(snap.finals);
    const j = judgeCall(req.tool, args, ev, row.state, { minWordConfidence: this.minConf });
    if (!j.ok) return this.hold(req, vid, t0, j.code, j.detail, this.evSummary(snap), { item_id: j.item_id, evidenced_value: j.evidenced_value });

    // 5. projected diff
    const proj = applyTool(row.state, req.tool, args);
    if (!proj.ok) {
      if (proj.error_code === 'NO_CHANGE') {
        // an exact repeat of committed state: valid, harmless, writes nothing (D-20). Never turns a HOLD into an ALLOW.
        // The call passed full validation, so it also closes an open repair on its scope.
        const nscope = req.tool === 'confirm_order' ? 'order' : (args.item_id as string | undefined) ?? 'order';
        const nopen = store.repairState(req.session_id, nscope);
        let nrep = false;
        if (nopen.pending > 0 || nopen.escalated) { store.resolveRepairs(req.session_id, [nscope]); this.notify({ outcome: 'resolved', scope: nscope, aai_call_id: req.aai_call_id }); nrep = true; }
        return { verdict: 'ALLOW', validation_event_id: vid, actual_result: { state: row.state, total_cents: row.total_cents, message: proj.message }, noop: true, waited_ms: this.clock.now() - t0, ...(nrep ? { repaired: true } : {}) };
      }
      return this.hold(req, vid, t0, 'SCHEMA_INVALID', `${proj.error_code}: ${proj.message}`, { ...this.evSummary(snap), judge: j.evidence }, { projection_error: proj.error_code, item_id: args.item_id as string | undefined });
    }

    // 6. ALLOW: the ONLY place an AllowDecision is minted.
    // Step 6: a repair is resolved ONLY by a call that just passed every check above (re-validation), never by the customer's words alone
    const scopes = [req.tool === 'confirm_order' ? 'order' : (args.item_id as string | undefined) ?? 'order'];
    const allow = mintAllow(vid, req.session_id, req.aai_call_id);
    const t_verdict = this.clock.now();
    const creq: CommitRequest = {
      session_id: req.session_id, aai_call_id: req.aai_call_id, tool: req.tool, args, execution_mode: executionMode(req.tool as ToolName),
      claimed_result: { arguments: args }, evidence: { ...this.evSummary(snap), judge: j.evidence, waited_ms: t_verdict - t0 },
      t_received_ms: t0, t_verdict_ms: t_verdict, resolves_scopes: scopes,
    };
    const open = scopes.filter((s) => { const st = store.repairState(req.session_id, s); return st.pending > 0 || st.escalated; });
    const committed = (this.o.commit ?? ((a, r) => store.commit(a, r)))(allow, creq);
    let repaired = false;
    if (!committed.ok) {
      return this.hold(req, vid, t0, 'UNVALIDATABLE', `commit refused: ${committed.error_code}: ${committed.message}`, this.evSummary(snap), { projection_error: committed.error_code });
    }

    for (const s of open) this.notify({ outcome: 'resolved', scope: s, aai_call_id: req.aai_call_id });
    repaired = open.length > 0;

    // 7. READ-BACK (rule: the tool's reported result is never trusted; re-read what the database actually holds)
    const rb = store.getOrder(req.session_id);
    // the stored total is never trusted: it must equal the total RECOMPUTED from the stored lines (Step 10)
    if (rb && rb.total_cents !== computeTotalCents(rb.state.lines)) {
      store.flagToolCall(committed.tool_call_id, req.session_id, 'TOTAL_MISMATCH', `stored total ${rb.total_cents}c, recomputed ${computeTotalCents(rb.state.lines)}c`);
      return { verdict: 'HOLD', code: 'TOTAL_MISMATCH', validation_event_id: vid, detail: 'the stored total does not match the total recomputed from the order lines', waited_ms: this.clock.now() - t0 };
    }
    const same = rb && JSON.stringify(rb.state.lines) === JSON.stringify(committed.state.lines) && rb.total_cents === committed.total_cents && rb.state.status === committed.state.status;
    if (!same) {
      store.flagToolCall(committed.tool_call_id, req.session_id, 'TOOL_RESULT_LIE', `committer reported ${JSON.stringify(committed.state.lines)} / ${committed.total_cents}c; database holds ${JSON.stringify(rb?.state.lines)} / ${rb?.total_cents}c`);
      return { verdict: 'HOLD', code: 'TOOL_RESULT_LIE', validation_event_id: vid, detail: 'the committed result does not match the database read-back', waited_ms: this.clock.now() - t0 };
    }
    return { verdict: 'ALLOW', validation_event_id: vid, actual_result: { state: rb.state, total_cents: rb.total_cents }, waited_ms: this.clock.now() - t0, ...(repaired ? { repaired: true } : {}) };
  }

  private evSummary(snap: ReturnType<EvidenceTracker['snapshot']>): Record<string, unknown> {
    return {
      source: 'independent_stt', stream_status: snap.streamStatus, speech_in_flight: snap.speechInFlight,
      utterances: snap.finals.map((u) => u.text), turn_orders: snap.finalTurnOrders, reasons: snap.reasons,
    };
  }

  private notify(r: RepairNotice): void {
    try { this.o.onRepair?.(r); } catch { /* an observer must never affect a verdict */ }
  }

  private hold(req: ToolCallRequest, vid: string, t0: number, code: ConflictCode, detail: string, evidence: Record<string, unknown>, x: HoldExtra): GateResult {
    const t_verdict = this.clock.now();
    const definite = !NON_DEFINITE_CODES.includes(code);
    const repairable = x.projection_error === undefined && x.repairable !== false;
    const max = this.o.maxRepairAttempts ?? MAX_REPAIR_ATTEMPTS;
    const scope = x.item_id ?? 'order';
    // ITEM_MISMATCH: the customer asked for a different item; the dispute is closed by a valid call on EITHER item
    const alt = code === 'ITEM_MISMATCH' && x.evidenced_value ? MENU.find((m) => m.name.toLowerCase() === x.evidenced_value)?.item_id : undefined;
    let repair: RepairInstruction | undefined;
    let record: RepairRecord | undefined;
    if (repairable) {
      const ctx = { item_id: x.item_id, evidenced_value: x.evidenced_value };
      let st = { pending: 0, escalated: false };
      try { st = this.o.store.repairState(req.session_id, scope); } catch { /* unreadable repair state: ask attempt 1, the hold itself is unaffected */ }
      const attempt = st.pending + 1;
      if (st.escalated || attempt > max) {
        // attempts exhausted: stop asking. Nothing is committed for this scope; other items are untouched.
        repair = { aai_call_id: req.aai_call_id, code, item_id: x.item_id, evidenced_value: x.evidenced_value, ask_text: escalationText(ctx), attempt: max + 1, escalated: true };
        if (!st.escalated) record = { scope, alt_scope: alt, attempt: max + 1, prompt: repair.ask_text, outcome: 'escalated' };
      } else {
        repair = { aai_call_id: req.aai_call_id, code, item_id: x.item_id, evidenced_value: x.evidenced_value, ask_text: repairAsk(code, ctx), attempt };
        record = { scope, alt_scope: alt, attempt, prompt: repair.ask_text, outcome: 'pending' };
      }
    }
    const utterances = (evidence as { utterances?: string[] }).utterances ?? [];
    const pattern = derivePattern({ code, tool: req.tool, item_id: x.item_id, utterances, detail });
    const threshold = this.o.regressionThreshold ?? 3;
    const audio = (() => { try { return this.o.store.sessionAudio(req.session_id); } catch { return undefined; } })();
    const exists = this.o.audioExists ?? existsSync;
    try {
      const tcId = this.o.store.recordHold({
        session_id: req.session_id, aai_call_id: req.aai_call_id, tool: req.tool, args: req.args, execution_mode: isMutating(req.tool) ? executionMode(req.tool as ToolName) : 'interactive',
        status: definite && x.projection_error === undefined ? 'conflict' : 'held', code, detail, evidence, validation_event_id: vid, t_received_ms: t0, t_verdict_ms: t_verdict, repair: record,
        case: { pattern_key: pattern.key, threshold, up_to_ms: t_verdict, audio_exists: !!audio?.pointer && exists(audio.pointer) },
      });
      const c = this.o.store.caseByToolCall(tcId);
      if (c) { try { this.o.onCase?.({ case_id: c.id, tool_call_id: tcId, conflict_type: c.conflict_type, pattern_key: c.pattern_key, tag: c.tag, pattern_count: c.pattern_count, resolution: c.resolution, threshold_reached: c.pattern_count >= threshold }); } catch { /* observer */ } }
    } catch { /* recording failed: the answer is still HOLD, nothing was written to orders */ }
    if (repair) this.notify({ outcome: repair.escalated ? 'escalated' : 'asked', scope, aai_call_id: req.aai_call_id, code, attempt: repair.attempt, ask_text: repair.ask_text });
    return { verdict: 'HOLD', code, validation_event_id: vid, repair, detail, projection_error: x.projection_error, waited_ms: t_verdict - t0 };
  }
}
