import type { ConflictCode } from './conflict.js';
import { MENU } from './menu.js';
import { humanList, itemName, quantityPhrase, spokenModifiers } from './spoken.js';

/**
 * Repair templates: scoped to the disputed item only (PRD §B.9). Data only; Tally never speaks.
 * Every value is put through `spoken.ts`: no internal identifier or evidence string may be read aloud (DECISIONS D-28).
 */
export interface RepairContext {
  item_id?: string;
  evidenced_value?: string;
}

const nameOf = (c: RepairContext): string => itemName(c.item_id);
const isNum = (v: string | undefined): v is string => v !== undefined && /^\d+$/.test(v);

export const REPAIR_TEMPLATES: Record<ConflictCode, (c: RepairContext) => string> = {
  QTY_MISMATCH: (c) => (isNum(c.evidenced_value)
    ? `Just to confirm, that's ${quantityPhrase(c.item_id, Number(c.evidenced_value))}?`
    : `Just to confirm, how many ${itemName(c.item_id, 2)} would you like?`),
  // only a value that IS a menu item is echoed; any other shape is never read aloud
  ITEM_MISMATCH: (c) => {
    const it = MENU.find((m) => m.item_id === c.evidenced_value || m.name.toLowerCase() === c.evidenced_value);
    return `Sorry, which item did you want${it ? `, the ${itemName(it.item_id)}` : ''}?`;
  },
  MODIFIER_MISMATCH: (c) => {
    const m = spokenModifiers(c.evidenced_value);
    if (m) return `Just to confirm, you'd like the ${nameOf(c)} with ${humanList(m)}?`;
    return c.evidenced_value === 'plain'
      ? `Just to confirm, you'd like the ${nameOf(c)} just as it comes, with no changes?`
      : `Just checking, how would you like the ${nameOf(c)} made?`;
  },
  REMOVAL_MISMATCH: (c) => {
    const v = c.evidenced_value;
    if (v === 'removed') return `Just to confirm, you'd like to take the ${nameOf(c)} off your order?`;
    if (v?.startsWith('keep ')) return `Just to confirm, you'd like to keep the ${nameOf(c)} on your order?`;
    const m = spokenModifiers(v);
    if (m) return `Just to confirm, you'd like the ${nameOf(c)} with ${humanList(m)}?`;
    if (v === 'plain') return `Just to confirm, you'd like the ${nameOf(c)} just as it comes, with nothing taken off?`;
    return `Just to confirm, what would you like taken off the ${nameOf(c)}?`;
  },
  SUBSTITUTION_MISMATCH: (c) => {
    const m = spokenModifiers(c.evidenced_value);
    if (m) return `Just to confirm, you'd like the ${nameOf(c)} with ${humanList(m)}?`;
    return `Just to confirm, would you like a swap on the ${nameOf(c)}?`;
  },
  STALE_EVIDENCE: (c) => `Sorry, I want to be sure I have the ${nameOf(c)} right. What did you want?`,
  UNSUPPORTED_CLAIM: (c) => `Did you want to add ${c.item_id ? `a ${nameOf(c)}` : 'that item'} to your order?`,
  SPOKEN_STATE_DRIFT: (c) => {
    if (c.evidenced_value === 'not_on_order') return `Let me correct that. I don't have any ${itemName(c.item_id, 2)} on your order.`;
    return isNum(c.evidenced_value)
      ? `Let me correct that. Your order has ${quantityPhrase(c.item_id, Number(c.evidenced_value))}. Is that right?`
      : `Let me correct that. I want to double-check how many ${itemName(c.item_id, 2)} are on your order.`;
  },
  TOOL_RESULT_LIE: (c) => `Let me double check the ${nameOf(c)} on your order. Is that right?`,
  TOTAL_MISMATCH: (c) => (c.evidenced_value && /^\$\d+\.\d{2}$/.test(c.evidenced_value) ? `Let me correct that. Your total is ${c.evidenced_value}.` : 'Let me recheck your total.'),
  SCHEMA_INVALID: (c) => `Sorry, could you say that again for the ${nameOf(c)}?`,
  UNKNOWN_ITEM: () => 'Sorry, I did not catch that item. Could you say it again?',
  BAD_MODIFIER: (c) => `Sorry, I can't do that on the ${nameOf(c)}. What would you like instead?`,
  PICKUP_TIME_MISMATCH: (c) => {
    const v = c.evidenced_value;
    if (!v || v === 'none') return 'What time would you like to pick up?';
    if (/^as soon as possible$/i.test(v)) return "Just to confirm, you'd like it as soon as possible?";
    if (/^\d{1,2}:\d{2}$/.test(v)) return `Just to confirm, pickup at ${v}?`;
    return 'Just to confirm, what time would you like to pick up?';
  },
  PENDING_EVIDENCE: (c) => `Sorry, I want to be sure I got the ${nameOf(c)} right. Could you say that once more?`,
  UNVALIDATABLE: (c) => `Sorry, could you repeat that for the ${nameOf(c)}?`,
};

/** PRD §B.9: at most this many scoped questions per disputed item; the next unresolved hold escalates. */
export const MAX_REPAIR_ATTEMPTS = 2;

/** Escalation: Tally stops asking. Scoped to the disputed item only; the rest of the order is untouched. */
export function escalationText(ctx: RepairContext): string {
  return ctx.item_id
    ? `I'm not able to confirm the ${nameOf(ctx)} myself, so a team member will confirm that one with you at pickup. Let's carry on with the rest of your order.`
    : "I'm not able to confirm that myself, so a team member will check it with you at pickup. Let's carry on.";
}

export function repairAsk(code: ConflictCode, ctx: RepairContext): string {
  return REPAIR_TEMPLATES[code](ctx);
}
