// Pure evidence-vs-claim judgement (VALIDATE). Given what the CUSTOMER said (independent stream, via the extractor), the
// current order, and a schema-valid tool call, decide whether the call is supported. Fail closed: only an explicit,
// definite match returns ok. The agent's own words are never an input here (rule 3).
import { getItem, modifierClass, type ConflictCode } from '@tally/contract';
import type { EvidenceState } from './extractor.js';
import { sameMods } from './extractor.js';
import type { OrderState } from './order.js';

export type Judgement =
  | { ok: true; evidence: Record<string, unknown> }
  | { ok: false; code: ConflictCode; detail: string; item_id?: string; evidenced_value?: string };

export interface JudgeOptions { minWordConfidence: number }

const fail = (code: ConflictCode, detail: string, item_id?: string, evidenced_value?: string): Judgement => ({ ok: false, code, detail, item_id, evidenced_value });
const modCode = (m: string): ConflictCode => (modifierClass(m) === 'removal' ? 'REMOVAL_MISMATCH' : modifierClass(m) === 'substitution' ? 'SUBSTITUTION_MISMATCH' : 'MODIFIER_MISMATCH');
const plain = (s: ReadonlySet<string>) => ([...s].sort().join(', ') || 'plain');

/** Which items does the evidence mention that are neither the claimed item nor already on the order? */
function otherEvidencedItems(ev: EvidenceState, claimed: string, order: OrderState): string[] {
  const onOrder = new Set(order.lines.map((l) => l.item_id));
  return [...ev.items.values()].filter((e) => !e.removed && e.item_id !== claimed && !onOrder.has(e.item_id)).map((e) => e.item_id);
}

function itemEvidenceChecks(ev: EvidenceState, item_id: string, order: OrderState, opts: JudgeOptions): Judgement | { e: NonNullable<ReturnType<EvidenceState['items']['get']>> } {
  const e = ev.items.get(item_id);
  if (!e || e.removed || e.quantity === null) {
    const others = otherEvidencedItems(ev, item_id, order);
    if (others.length) return fail('ITEM_MISMATCH', `the customer asked for ${others.join(', ')}, not ${item_id}`, item_id, getItem(others[0]!)?.name.toLowerCase());
    return fail('UNSUPPORTED_CLAIM', `nothing the customer said supports ${item_id}`, item_id);
  }
  if (e.quantityAmbiguous) return fail('UNVALIDATABLE', `ambiguous quantity for ${item_id}: a homophone (to/too/for) was read as a number`, item_id, String(e.quantity));
  if (e.minConf !== null && e.minConf < opts.minWordConfidence) {
    return fail('UNVALIDATABLE', `low confidence (${e.minConf.toFixed(2)} < ${opts.minWordConfidence}) on the words for ${item_id}'s quantity/item`, item_id, String(e.quantity));
  }
  return { e };
}

export function judgeCall(tool: string, args: Record<string, unknown>, ev: EvidenceState, order: OrderState, opts: JudgeOptions): Judgement {
  const item_id = args.item_id as string | undefined;

  switch (tool) {
    case 'add_item': {
      const r = itemEvidenceChecks(ev, item_id!, order, opts);
      if (!('e' in r)) return r;
      const e = r.e;
      const qty = args.quantity as number;
      if (e.quantity !== qty) return fail('QTY_MISMATCH', `claimed quantity ${qty}, the customer said ${e.quantity}`, item_id, String(e.quantity));
      const mods = args.modifiers as string[];
      const wanted = new Set(mods);
      for (const m of mods) if (!e.modifiers.has(m)) return fail(modCode(m), `claimed modifier ${m} was never requested`, item_id, plain(e.modifiers));
      for (const m of e.modifiers) if (!wanted.has(m)) return fail(modCode(m), `the customer asked for ${m} but the call omits it`, item_id, plain(e.modifiers));
      return { ok: true, evidence: { item_id, quantity: e.quantity, modifiers: [...e.modifiers].sort(), min_conf: e.minConf } };
    }
    case 'update_quantity': {
      const r = itemEvidenceChecks(ev, item_id!, order, opts);
      if (!('e' in r)) return r;
      const qty = args.quantity as number;
      if (r.e.quantity !== qty) return fail('QTY_MISMATCH', `claimed quantity ${qty}, the customer said ${r.e.quantity}`, item_id, String(r.e.quantity));
      return { ok: true, evidence: { item_id, quantity: r.e.quantity, min_conf: r.e.minConf } };
    }
    case 'apply_modifier': {
      const mod = args.modifier as string;
      const e = ev.items.get(item_id!);
      if (!e || e.removed) return fail('UNSUPPORTED_CLAIM', `nothing the customer said supports a modifier on ${item_id}`, item_id);
      if (!e.modifiers.has(mod)) return fail(modCode(mod), `claimed modifier ${mod} was never requested`, item_id, plain(e.modifiers));
      return { ok: true, evidence: { item_id, modifier: mod } };
    }
    case 'remove_item': {
      const e = ev.items.get(item_id!);
      if (!e || !e.removed) return fail('REMOVAL_MISMATCH', `the customer did not ask to remove ${item_id}`, item_id, e ? `keep ${e.quantity}` : undefined);
      return { ok: true, evidence: { item_id, removed: true } };
    }
    case 'confirm_order': {
      // FINAL CHECKPOINT (D-22): the order about to be confirmed must equal what the customer said. This closes the gap where a
      // correction began AFTER an earlier call was allowed and the agent never applied it (spike-a: correction_during_hold).
      const rec = reconcileOrderWithEvidence(order, ev, opts);
      if (rec) return rec;
      const p = ev.pickup;
      const arg = args.pickup_time as string;
      if (!p) return fail('PICKUP_TIME_MISMATCH', 'the customer gave no pickup time', undefined, 'none');
      if (p.kind === 'asap') {
        return arg === 'ASAP' ? { ok: true, evidence: { pickup: 'ASAP' } } : fail('PICKUP_TIME_MISMATCH', `claimed ${arg}, the customer said as soon as possible`, undefined, 'as soon as possible');
      }
      const m = /T(\d{2}):(\d{2})/.exec(arg);
      if (!m) return fail('PICKUP_TIME_MISMATCH', `claimed ${arg}, the customer said ${p.hour}:${String(p.minute).padStart(2, '0')}`, undefined, `${p.hour}:${String(p.minute).padStart(2, '0')}`);
      const h = Number(m[1]); const mi = Number(m[2]);
      const hourOk = h % 12 === p.hour % 12 && (p.meridiem === null || (p.meridiem === 'pm') === h >= 12);
      return hourOk && mi === p.minute ? { ok: true, evidence: { pickup: arg } } : fail('PICKUP_TIME_MISMATCH', `claimed ${arg}, the customer said ${p.hour}:${String(p.minute).padStart(2, '0')}`, undefined, `${p.hour}:${String(p.minute).padStart(2, '0')}`);
    }
    default:
      return fail('SCHEMA_INVALID', `tool ${tool} is not gated`);
  }
}

/**
 * Compare the committed order with the evidenced intent, item by item. Returns a HOLD judgement on the first disagreement,
 * or null when the order is exactly what the customer said. Ambiguity / low confidence also hold (cannot validate).
 */
export function reconcileOrderWithEvidence(order: OrderState, ev: EvidenceState, opts: JudgeOptions): Judgement | null {
  const onOrder = new Map(order.lines.map((l) => [l.item_id, l]));
  for (const e of ev.items.values()) {
    const line = onOrder.get(e.item_id);
    if (e.removed) {
      if (line) return fail('REMOVAL_MISMATCH', `the customer removed ${e.item_id} but it is still on the order`, e.item_id, 'removed');
      continue;
    }
    if (e.quantity === null) continue;
    if (e.quantityAmbiguous) return fail('UNVALIDATABLE', `ambiguous quantity for ${e.item_id} in the customer's speech`, e.item_id, String(e.quantity));
    if (e.minConf !== null && e.minConf < opts.minWordConfidence) return fail('UNVALIDATABLE', `low confidence on the words for ${e.item_id}`, e.item_id, String(e.quantity));
    if (!line) return fail('ITEM_MISMATCH', `the customer asked for ${e.item_id} but it is not on the order`, e.item_id, getItem(e.item_id)?.name.toLowerCase());
    if (line.quantity !== e.quantity) return fail('QTY_MISMATCH', `the order has ${line.quantity} ${e.item_id}, the customer said ${e.quantity}`, e.item_id, String(e.quantity));
    for (const m of e.modifiers) if (!line.modifiers.includes(m)) return fail(modCode(m), `the customer asked for ${m} on ${e.item_id} but the order lacks it`, e.item_id, plain(e.modifiers));
    for (const m of line.modifiers) if (!e.modifiers.has(m)) return fail(modCode(m), `the order has ${m} on ${e.item_id}, which the customer never asked for`, e.item_id, plain(e.modifiers));
  }
  for (const line of order.lines) {
    if (!ev.items.has(line.item_id)) return fail('UNSUPPORTED_CLAIM', `${line.item_id} is on the order but the customer never asked for it`, line.item_id);
  }
  return null;
}

export { sameMods };
