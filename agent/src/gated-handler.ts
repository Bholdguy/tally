import type { Gate } from '@tally/reliability';
import type { ToolHandler } from './session.js';
import { errorResult, heldResult, noopResult, okResult, orderStateResult, type OrderView } from './repair-adapter.js';

/**
 * THE Plane 1 tool handler for live/demo/replay sessions (Step 5). Every tool.call from the Voice Agent goes through
 * Tally's gate; this module has no database handle and no other way to change an order (rule 8, ARCHITECTURE §4.2).
 * It only translates the gate's data-only verdict into the wire result the agent will narrate from:
 *   ALLOW  -> {status:"OK", order, total}         (agent may now confirm aloud)
 *   NOOP   -> {status:"NOOP", ...}                 (exact repeat of committed state: nothing changed, nothing went wrong)
 *   HOLD   -> {status:"HELD", instruction}         (agent must ask the scoped question; Tally supplies instructions only, D-09)
 *   misuse -> {status:"ERROR", ...}                (agent used a tool wrongly; no customer question)
 * The spike pass-through stub (agent/src/spike) is unreachable from here.
 */
export function createGatedHandler(gate: Gate, session_id: string): ToolHandler {
  const view = (o: unknown): OrderView | undefined => {
    const x = o as { state?: { lines?: OrderView['lines']; status?: string }; lines?: OrderView['lines']; total_cents?: number; status?: string } | null;
    const lines = x?.state?.lines ?? x?.lines;
    if (!lines || typeof x?.total_cents !== 'number') return undefined;
    return { lines, total_cents: x.total_cents, status: x.state?.status ?? x.status ?? 'open' };
  };

  return async (call) => {
    if (call.tool === 'get_order_state') {
      const st = gate.readState(session_id);
      return st ? orderStateResult({ lines: st.lines, total_cents: st.total_cents, status: st.status }) : errorResult('NO_ORDER', 'There is no order for this call.');
    }
    const r = await gate.submit({ session_id, aai_call_id: call.aai_call_id, tool: call.tool, args: call.args, received_t_ms: call.received_t_ms });
    if (r.verdict === 'ALLOW') {
      const v = view(r.actual_result);
      if (!v) return errorResult('NO_STATE', 'The order state could not be read back.');
      // the gate's internal NO_CHANGE message names ids ("no_onions is already applied to burger"); the agent gets fixed natural wording (D-28)
      return r.noop ? noopResult(v, 'That is already on the order exactly as requested.') : okResult(v);
    }
    if (r.repair) return heldResult(r.repair);
    return errorResult(r.projection_error ?? r.code, r.detail ?? 'The request could not be applied.');
  };
}
