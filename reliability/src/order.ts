import { computeTotalCents, FLAVORS, getItem, type OrderLine } from '@tally/contract';

export interface OrderState {
  lines: OrderLine[];
  status: 'open' | 'confirmed' | 'cancelled';
  pickup_time: string | null;
}

export type ApplyResult =
  | { ok: true; state: OrderState; total_cents: number }
  | { ok: false; error_code: 'ORDER_CLOSED' | 'ALREADY_IN_ORDER' | 'NO_CHANGE' | 'NOT_IN_ORDER' | 'EMPTY_ORDER' | 'INVALID' | 'NOT_MUTATING'; message: string };

// One line per item_id: modifiers apply to the whole line (D-17 known limitation). Mutually exclusive groups replace.
const EXCLUSIVE_GROUPS: string[][] = [[...FLAVORS], ['size_large', 'size_small'], ['no_ice', 'extra_ice']];

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
const clone = (s: OrderState): OrderState => ({ ...s, lines: s.lines.map((l) => ({ ...l, modifiers: [...l.modifiers] })) });
const fail = (error_code: Extract<ApplyResult, { ok: false }>['error_code'], message: string): ApplyResult => ({ ok: false, error_code, message });

/** Pure projection of a validated tool call onto an order. Used by the gate (projected diff) and the committer (write). */
export function applyTool(prev: OrderState, tool: string, args: Record<string, unknown>): ApplyResult {
  if (prev.status !== 'open') return fail('ORDER_CLOSED', `order is ${prev.status}`);
  const s = clone(prev);
  const item_id = args.item_id as string | undefined;
  const line = item_id ? s.lines.find((l) => l.item_id === item_id) : undefined;

  switch (tool) {
    case 'add_item': {
      if (!item_id || !getItem(item_id)) return fail('INVALID', 'unknown item');
      if (line) {
        // D-20: an exact repeat of what is already committed is a harmless duplicate (NO_CHANGE), not a conflict
        const same = line.quantity === (args.quantity as number) && sameSet(line.modifiers, args.modifiers as string[]);
        return same
          ? fail('NO_CHANGE', `${item_id} is already on the order exactly as requested`)
          : fail('ALREADY_IN_ORDER', `${item_id} is already on the order; use update_quantity or apply_modifier`);
      }
      s.lines.push({ item_id, quantity: args.quantity as number, modifiers: [...(args.modifiers as string[])].sort() });
      break;
    }
    case 'remove_item': {
      if (!line) return fail('NOT_IN_ORDER', `${item_id} is not on the order`);
      s.lines = s.lines.filter((l) => l.item_id !== item_id);
      break;
    }
    case 'update_quantity': {
      const target = s.lines.find((l) => l.item_id === item_id);
      if (!target) return fail('NOT_IN_ORDER', `${item_id} is not on the order`);
      if (target.quantity === (args.quantity as number)) return fail('NO_CHANGE', `${item_id} quantity is already ${target.quantity}`);
      target.quantity = args.quantity as number;
      break;
    }
    case 'apply_modifier': {
      const target = s.lines.find((l) => l.item_id === item_id);
      if (!target) return fail('NOT_IN_ORDER', `${item_id} is not on the order`);
      const mod = args.modifier as string;
      const group = EXCLUSIVE_GROUPS.find((g) => g.includes(mod));
      if (target.modifiers.includes(mod)) return fail('NO_CHANGE', `${mod} is already applied to ${item_id}`);
      if (group) target.modifiers = target.modifiers.filter((m) => !group.includes(m));
      target.modifiers.push(mod);
      target.modifiers.sort();
      break;
    }
    case 'confirm_order': {
      if (s.lines.length === 0) return fail('EMPTY_ORDER', 'cannot confirm an empty order');
      s.status = 'confirmed';
      s.pickup_time = args.pickup_time as string;
      break;
    }
    default:
      return fail('NOT_MUTATING', `${tool} does not mutate the order`);
  }
  s.lines.sort((a, b) => a.item_id.localeCompare(b.item_id));
  return { ok: true, state: s, total_cents: computeTotalCents(s.lines) };
}

export const emptyOrder = (): OrderState => ({ lines: [], status: 'open', pickup_time: null });
