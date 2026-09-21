import type { ConflictCode, RepairContext } from '../src/index.js';

/** One labelled example per conflict code. Step 5 turns these into gate-table rows; Step 14 into adversarial cases. */
export interface ConflictFixture {
  code: ConflictCode;
  tool: string;
  args: Record<string, unknown>;
  transcript: string[]; // finalised user utterances in order
  why: string;
  repair_ctx: RepairContext;
}

export const CONFLICT_FIXTURES: ConflictFixture[] = [
  { code: 'QTY_MISMATCH', tool: 'add_item', args: { item_id: 'burger', quantity: 2, modifiers: [] }, transcript: ['two burgers no wait make it three'], why: 'correction cue; last mention wins', repair_ctx: { item_id: 'burger', evidenced_value: '3' } },
  { code: 'ITEM_MISMATCH', tool: 'add_item', args: { item_id: 'cheeseburger', quantity: 1, modifiers: [] }, transcript: ['one veggie burger'], why: 'item differs', repair_ctx: { evidenced_value: 'veggie burger' } },
  { code: 'MODIFIER_MISMATCH', tool: 'add_item', args: { item_id: 'burger', quantity: 1, modifiers: ['extra_cheese'] }, transcript: ['one burger no onions'], why: 'modifier not evidenced / wrong', repair_ctx: { item_id: 'burger', evidenced_value: 'no_onions' } },
  { code: 'REMOVAL_MISMATCH', tool: 'remove_item', args: { item_id: 'fries' }, transcript: ['keep the fries but no salt'], why: 'removal not evidenced', repair_ctx: { item_id: 'fries', evidenced_value: 'no_salt' } },
  { code: 'SUBSTITUTION_MISMATCH', tool: 'apply_modifier', args: { item_id: 'burger', modifier: 'sub_chicken_for_beef' }, transcript: ['one burger'], why: 'swap not evidenced', repair_ctx: { item_id: 'burger' } },
  { code: 'STALE_EVIDENCE', tool: 'update_quantity', args: { item_id: 'burger', quantity: 2 }, transcript: ['make the burgers two', 'actually three'], why: 'later utterance supersedes the one relied on', repair_ctx: { item_id: 'burger' } },
  { code: 'UNSUPPORTED_CLAIM', tool: 'add_item', args: { item_id: 'milkshake', quantity: 1, modifiers: ['flavor_vanilla'] }, transcript: ['two burgers'], why: 'no utterance supports the call', repair_ctx: { item_id: 'milkshake' } },
  { code: 'SPOKEN_STATE_DRIFT', tool: 'add_item', args: { item_id: 'burger', quantity: 3, modifiers: [] }, transcript: ['three burgers'], why: 'agent said "two burgers" after committing 3', repair_ctx: { item_id: 'burger', evidenced_value: '3' } },
  { code: 'TOOL_RESULT_LIE', tool: 'add_item', args: { item_id: 'burger', quantity: 3, modifiers: [] }, transcript: ['three burgers'], why: 'handler returned qty 3 but DB read-back shows 2', repair_ctx: { item_id: 'burger' } },
  { code: 'TOTAL_MISMATCH', tool: 'get_order_state', args: { order_id: 'o1' }, transcript: [], why: 'reported total differs from recomputed', repair_ctx: {} },
  { code: 'SCHEMA_INVALID', tool: 'add_item', args: { item_id: 'burger', quantity: 0, modifiers: [] }, transcript: ['zero burgers'], why: 'quantity out of range', repair_ctx: { item_id: 'burger' } },
  { code: 'UNKNOWN_ITEM', tool: 'add_item', args: { item_id: 'pizza', quantity: 1, modifiers: [] }, transcript: ['a pizza'], why: 'not on menu', repair_ctx: {} },
  { code: 'BAD_MODIFIER', tool: 'apply_modifier', args: { item_id: 'fries', modifier: 'extra_cheese' }, transcript: ['fries with extra cheese'], why: 'modifier not in fries vocabulary', repair_ctx: { item_id: 'fries' } },
  { code: 'PICKUP_TIME_MISMATCH', tool: 'confirm_order', args: { order_id: 'o1', pickup_time: 'ASAP' }, transcript: ['pick up at six thirty'], why: 'pickup time differs from evidence', repair_ctx: { evidenced_value: 'at 6:30' } },
  { code: 'PENDING_EVIDENCE', tool: 'add_item', args: { item_id: 'burger', quantity: 2, modifiers: [] }, transcript: ['two burgers'], why: 'user speech still in flight when the call arrived', repair_ctx: { item_id: 'burger' } },
  { code: 'UNVALIDATABLE', tool: 'add_item', args: { item_id: 'burger', quantity: 2, modifiers: [] }, transcript: [], why: 'no finalised evidence at all', repair_ctx: { item_id: 'burger' } },
];
