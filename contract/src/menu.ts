// Seed menu and exact modifier vocabulary (PRD §B.4). Prices in integer cents.
export type ModifierClass = 'modifier' | 'removal' | 'substitution';

export interface MenuItem {
  item_id: string;
  name: string;
  price_cents: number;
  aliases: string[];
  modifiers: string[];
}

const BURGER_MODS = [
  'no_onions', 'no_pickles', 'no_tomato', 'no_lettuce', 'no_sauce',
  'extra_cheese', 'extra_pickles', 'extra_sauce', 'add_bacon', 'gluten_free_bun',
];
const DRINK_MODS = ['no_ice', 'extra_ice', 'size_large', 'size_small'];

export const MENU: readonly MenuItem[] = [
  { item_id: 'burger', name: 'Classic Burger', price_cents: 899, aliases: ['burger', 'hamburger', 'classic'], modifiers: [...BURGER_MODS, 'sub_chicken_for_beef'] },
  { item_id: 'cheeseburger', name: 'Cheeseburger', price_cents: 999, aliases: ['cheeseburger'], modifiers: [...BURGER_MODS.filter((m) => m !== 'extra_cheese'), 'sub_chicken_for_beef'] },
  { item_id: 'veggie_burger', name: 'Veggie Burger', price_cents: 949, aliases: ['veggie burger', 'garden burger'], modifiers: ['no_onions', 'no_pickles', 'no_tomato', 'no_lettuce', 'no_sauce', 'extra_cheese', 'extra_sauce', 'gluten_free_bun'] },
  { item_id: 'chicken_sandwich', name: 'Chicken Sandwich', price_cents: 999, aliases: ['chicken sandwich', 'chicken'], modifiers: ['no_pickles', 'no_lettuce', 'no_sauce', 'extra_sauce', 'extra_pickles', 'add_bacon', 'gluten_free_bun', 'spicy'] },
  { item_id: 'fries', name: 'French Fries', price_cents: 349, aliases: ['fries', 'chips'], modifiers: ['no_salt', 'extra_crispy', 'add_cheese'] },
  { item_id: 'onion_rings', name: 'Onion Rings', price_cents: 449, aliases: ['onion rings', 'rings'], modifiers: ['no_salt', 'extra_crispy'] },
  { item_id: 'side_salad', name: 'Side Salad', price_cents: 399, aliases: ['salad', 'side salad'], modifiers: ['no_onions', 'no_tomato', 'dressing_ranch', 'dressing_vinaigrette'] },
  { item_id: 'coke', name: 'Coke', price_cents: 249, aliases: ['coke', 'cola'], modifiers: DRINK_MODS },
  { item_id: 'diet_coke', name: 'Diet Coke', price_cents: 249, aliases: ['diet coke', 'diet'], modifiers: DRINK_MODS },
  { item_id: 'lemonade', name: 'Lemonade', price_cents: 299, aliases: ['lemonade'], modifiers: DRINK_MODS },
  { item_id: 'milkshake', name: 'Milkshake', price_cents: 549, aliases: ['milkshake', 'shake'], modifiers: ['flavor_vanilla', 'flavor_chocolate', 'flavor_strawberry', 'no_whip'] },
  { item_id: 'cookie', name: 'Cookie', price_cents: 199, aliases: ['cookie'], modifiers: ['warm'] },
];

export const MODIFIER_PRICE_DELTAS: Readonly<Record<string, number>> = {
  extra_cheese: 100, add_bacon: 150, add_cheese: 75, gluten_free_bun: 100, size_large: 75, sub_chicken_for_beef: 100,
};

export const ITEM_IDS = MENU.map((m) => m.item_id) as [string, ...string[]];
export const ALL_MODIFIERS = [...new Set(MENU.flatMap((m) => m.modifiers))].sort() as [string, ...string[]];

export const FLAVORS: readonly string[] = ['flavor_vanilla', 'flavor_chocolate', 'flavor_strawberry'];

export function getItem(item_id: string): MenuItem | undefined {
  return MENU.find((m) => m.item_id === item_id);
}

export function modifierClass(modifier: string): ModifierClass {
  if (modifier.startsWith('no_')) return 'removal';
  if (modifier.startsWith('sub_')) return 'substitution';
  return 'modifier';
}

export function isAllowedModifier(item_id: string, modifier: string): boolean {
  return getItem(item_id)?.modifiers.includes(modifier) ?? false;
}
