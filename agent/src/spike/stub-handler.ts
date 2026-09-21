// SPIKE ONLY. A pass-through tool handler with NO validation. It exists to observe AssemblyAI event ordering.
// It must never be reachable from live/demo/replay paths: agent/test/spike-isolation.test.ts fails if any file
// outside agent/src/spike imports this module, and the server refuses to construct it (Step 5 removes it entirely).
import { validateToolArgs } from '@tally/contract';
import { applyTool, emptyOrder, type OrderState } from '@tally/reliability';
import type { ToolCallInfo, ToolHandler } from '../session.js';
import { errorResult, okResult, orderStateResult } from '../repair-adapter.js';
import { injectOrderId } from '../tools.js';
import { computeTotalCents } from '@tally/contract';

export const SPIKE_STUB_MARKER = 'SPIKE_ONLY_NO_VALIDATION';

export interface StubHandle { handler: ToolHandler; calls: (ToolCallInfo & { result: string; done_t_ms: number })[]; state: () => OrderState }

export function makeSpikePassThrough(opts: { delayMs?: number; now: () => number }): StubHandle {
  let state = emptyOrder();
  const calls: StubHandle['calls'] = [];
  const handler: ToolHandler = async (call) => {
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    const args = injectOrderId(call.tool, call.args, 'spike-order');
    let result: string;
    const v = validateToolArgs(call.tool, args);
    if (!v.ok) {
      result = errorResult('SCHEMA_INVALID', v.issues.join('; '));
    } else if (call.tool === 'get_order_state') {
      result = orderStateResult({ lines: state.lines, total_cents: computeTotalCents(state.lines), status: state.status });
    } else {
      const r = applyTool(state, call.tool, v.args);
      if (r.ok) { state = r.state; result = okResult({ lines: r.state.lines, total_cents: r.total_cents, status: r.state.status }); }
      else result = errorResult(r.error_code, r.message);
    }
    calls.push({ ...call, result, done_t_ms: opts.now() });
    return result;
  };
  return { handler, calls, state: () => state };
}
