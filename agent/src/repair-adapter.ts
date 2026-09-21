import { computeTotalCents, describeLine, type OrderLine, type RepairInstruction } from '@tally/contract';

/**
 * RepairAdapter (Plane 1). The ONLY place a Tally RepairInstruction becomes wire content (DECISIONS D-09).
 * Tally supplies data; the reference agent does all speaking. In hold mode the tool result itself triggers the
 * agent's next reply, so no separate reply.create is sent by default (docs: don't send one after a hold result).
 */
export interface OrderView { lines: OrderLine[]; total_cents: number; status: string }

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * Order lines as the agent receives them. `spoken` is the ONLY wording meant to be said aloud; item_id / modifier ids are
 * for tool calls, and an id read to a customer ("veggie underscore burger") is a defect (DECISIONS D-28).
 */
const withSpoken = (ls: OrderLine[]) => ls.map((x) => ({ ...x, spoken: describeLine(x) }));

export function okResult(order: OrderView): string {
  return JSON.stringify({
    status: 'OK',
    order: withSpoken(order.lines),
    total: usd(computeTotalCents(order.lines)),      // recomputed from the lines: a stored total is never repeated as-is (Step 10)
    order_status: order.status,
  });
}

export function heldResult(r: RepairInstruction): string {
  if (r.escalated) {
    // Attempts exhausted (PRD §B.9): stop asking. Only the disputed item is affected; the rest of the order carries on.
    return JSON.stringify({
      status: 'HELD',
      code: r.code,
      escalated: true,
      instruction: `Nothing was changed on the order for this item and it cannot be added by you. Do not ask about it again and do not call a tool for it again. Tell the customer, in your own natural words: "${r.ask_text}" Then continue with the rest of the order as normal.`,
    });
  }
  return JSON.stringify({
    status: 'HELD',
    code: r.code,
    instruction: `Nothing was changed on the order. Do not confirm or repeat the action. Ask the customer this question, keeping every number and item exactly as written (do not substitute what you remember; the number in the question is the one being checked): "${r.ask_text}" Then wait for their answer and do not call any tool until they reply.`,
  });
}

/** Customer-safe wording per failure code. The internal detail never goes in `message` (D-28). */
const NATURAL_ERRORS: Record<string, string> = {
  ORDER_CLOSED: 'That order is already finished, so it cannot be changed.',
  ALREADY_IN_ORDER: 'That item is already on the order, so it needs to be changed rather than added again.',
  NOT_IN_ORDER: 'That item is not on the order.',
  EMPTY_ORDER: 'There is nothing on the order yet to confirm.',
  INVALID: 'That request could not be understood.',
  NOT_MUTATING: 'That request could not be applied.',
  SCHEMA_INVALID: 'That request was missing details it needs.',
  UNKNOWN_ITEM: 'That item is not on the menu.',
  BAD_MODIFIER: 'That option is not available for that item.',
  NO_ORDER: 'There is no order for this call.',
  NO_STATE: 'The order could not be read just now.',
};

/**
 * Encode failures in the result JSON itself: docs disagree on a separate is_error flag (D-13).
 * `message` is natural language safe to paraphrase to the customer. The technical detail (item ids, tool names) is kept apart in
 * `agent_note`, labelled as never to be spoken, so the agent can correct its own call without reading identifiers aloud.
 */
export function errorResult(code: string, technical: string): string {
  const message = NATURAL_ERRORS[code] ?? 'Something went wrong applying that request.';
  return JSON.stringify({
    status: 'ERROR',
    code,
    message: `${message} Tell the customer briefly and ask how they would like to proceed. Do not retry silently.`,
    agent_note: `For your own tool use only. Never say this aloud: ${technical}`,
  });
}

export function orderStateResult(order: OrderView): string {
  return JSON.stringify({ status: 'OK', order: withSpoken(order.lines), total: usd(computeTotalCents(order.lines)), order_status: order.status });
}

/** D-20: the call repeated what is already committed. Not an error; stops the agent apologising to the customer. */
export function noopResult(order: OrderView, message: string): string {
  return JSON.stringify({
    status: 'NOOP',
    message: `${message} Nothing changed and nothing went wrong. Do not apologise or mention a problem; carry on with the order.`,
    order: withSpoken(order.lines),
    total: usd(computeTotalCents(order.lines)),
  });
}

/**
 * STEP 10: a correction of the agent's OWN earlier statement (spoken drift). Sent as a one-shot `reply.create` instruction by Plane 1,
 * never as a tool result. Nothing on the order changes; the agent is told exactly what is true and must not call a tool.
 */
export function driftInstruction(r: RepairInstruction): string {
  if (r.escalated) {
    return `Something you said about the order was not accurate, and it has not been fixed after correcting it. Do not try to correct it again. Nothing on the order has changed. Tell the customer, in your own natural words: "${r.ask_text}" Do not call any tool.`;
  }
  return `Something you just said about the order was not accurate. Nothing on the order has changed. Correct yourself now: tell the customer, in your own natural words: "${r.ask_text}" Do not call any tool.`;
}
