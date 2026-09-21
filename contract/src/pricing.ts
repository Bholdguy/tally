import { getItem, MODIFIER_PRICE_DELTAS } from './menu.js';

export interface OrderLine {
  item_id: string;
  quantity: number;
  modifiers: string[];
}

export function unitPriceCents(line: Pick<OrderLine, 'item_id' | 'modifiers'>): number {
  const item = getItem(line.item_id);
  if (!item) throw new Error(`unknown item ${line.item_id}`);
  return item.price_cents + line.modifiers.reduce((s, m) => s + (MODIFIER_PRICE_DELTAS[m] ?? 0), 0);
}

export function lineTotalCents(line: OrderLine): number {
  return unitPriceCents(line) * line.quantity;
}

/** Order total = sum((base + modifier deltas) * quantity). Tax is out of scope (no payment). */
export function computeTotalCents(lines: readonly OrderLine[]): number {
  return lines.reduce((s, l) => s + lineTotalCents(l), 0);
}
