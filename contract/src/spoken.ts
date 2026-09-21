import { ALL_MODIFIERS, getItem, MENU } from './menu.js';
import type { OrderLine } from './pricing.js';

/**
 * SPOKEN FORM of internal identifiers. Anything the agent might read aloud (repair questions, hand-offs, tool results)
 * must go through these helpers; a raw item_id / modifier id / evidence string must never reach a customer's ears
 * ("extra_cheese" read as "extra underscore cheese"). Tested exhaustively in contract/test/spoken.test.ts (DECISIONS D-28).
 */
export const MODIFIER_LABELS: Readonly<Record<string, string>> = {
  no_onions: 'no onions', no_pickles: 'no pickles', no_tomato: 'no tomato', no_lettuce: 'no lettuce', no_sauce: 'no sauce',
  extra_cheese: 'extra cheese', extra_pickles: 'extra pickles', extra_sauce: 'extra sauce', add_bacon: 'added bacon',
  gluten_free_bun: 'a gluten-free bun', sub_chicken_for_beef: 'chicken instead of beef', spicy: 'the spicy option',
  no_salt: 'no salt', extra_crispy: 'extra crispy', add_cheese: 'added cheese',
  dressing_ranch: 'ranch dressing', dressing_vinaigrette: 'vinaigrette dressing',
  no_ice: 'no ice', extra_ice: 'extra ice', size_large: 'a large size', size_small: 'a small size',
  flavor_vanilla: 'vanilla flavor', flavor_chocolate: 'chocolate flavor', flavor_strawberry: 'strawberry flavor', no_whip: 'no whipped cream',
  warm: 'the warm option',
};

const PLURAL_OVERRIDES: Readonly<Record<string, string>> = {
  fries: 'french fries', chicken_sandwich: 'chicken sandwiches', onion_rings: 'onion rings',
};

export function modifierLabel(id: string): string {
  return MODIFIER_LABELS[id] ?? 'that option';
}

/** "a", "a and b", "a, b and c" */
export function humanList(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Lower-case spoken name of an item, singular or plural by quantity ("classic burger", "chicken sandwiches"). */
export function itemName(item_id: string | undefined, quantity?: number): string {
  const it = item_id ? getItem(item_id) : undefined;
  if (!it) return 'that item';
  const singular = it.name.toLowerCase();
  if (quantity === undefined || quantity === 1) return singular;
  return PLURAL_OVERRIDES[it.item_id] ?? `${singular}s`;
}

/** Items whose name is already a plural mass noun: "1 order of french fries", "2 orders of onion rings". */
const ORDER_OF = new Set(['fries', 'onion_rings']);

/** "3 classic burgers", "1 order of french fries" */
export function quantityPhrase(item_id: string | undefined, quantity: number): string {
  if (item_id && ORDER_OF.has(item_id)) return `${quantity} ${quantity === 1 ? 'order' : 'orders'} of ${itemName(item_id)}`;
  return `${quantity} ${itemName(item_id, quantity)}`;
}

/** "3 classic burgers with extra cheese and no onions" (quantity optional). */
export function describeLine(line: Pick<OrderLine, 'item_id' | 'modifiers'> & { quantity?: number }): string {
  const name = line.quantity !== undefined ? quantityPhrase(line.item_id, line.quantity) : itemName(line.item_id);
  const mods = [...line.modifiers].sort().map(modifierLabel);
  return mods.length ? `${name} with ${humanList(mods)}` : name;
}

/** The modifier ids the judge put in an evidence value, spoken; undefined for 'plain' or any non-modifier value. */
export function spokenModifiers(v: string | undefined): string[] | undefined {
  if (!v || v === 'plain') return undefined;
  const parts = v.split(/,\s*/).map((s) => s.trim()).filter(Boolean);
  return parts.length && parts.every((p) => ALL_MODIFIERS.includes(p)) ? parts.map(modifierLabel) : undefined;
}

/**
 * Turn an evidence value produced by the judge into speakable words. Handles every shape the judge emits: a modifier-id list
 * ("extra_cheese, no_onions"), an item id, item names, numbers, times. Unknown shapes are stripped of identifier punctuation
 * rather than read raw.
 */
export function speakValue(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const m = spokenModifiers(v);
  if (m) return humanList(m);
  if (MENU.some((x) => x.item_id === v)) return itemName(v);
  return v.replace(/_+/g, ' ');
}
