import { z } from 'zod';
import { ALL_MODIFIERS, FLAVORS, getItem, ITEM_IDS, MENU } from './menu.js';

const ItemId = z.enum(ITEM_IDS);
const ModifierId = z.enum(ALL_MODIFIERS);
const Qty = z.number().int().min(1).max(20);
const PickupTime = z.union([
  z.literal('ASAP'),
  z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/, 'ISO-8601 datetime with offset'),
]);

function checkModifiers(item_id: string, mods: string[], ctx: z.RefinementCtx, field: 'modifiers' | 'modifier') {
  const item = getItem(item_id);
  if (!item) return;
  mods.forEach((m, i) => {
    if (!item.modifiers.includes(m)) {
      ctx.addIssue({ code: 'custom', message: `modifier '${m}' not allowed for ${item_id}`, path: field === 'modifiers' ? [field, i] : [field] });
    }
  });
  if (item_id === 'milkshake' && field === 'modifiers' && mods.filter((m) => FLAVORS.includes(m)).length !== 1) {
    ctx.addIssue({ code: 'custom', message: 'milkshake requires exactly one flavor_*', path: [field] });
  }
}

export const AddItemArgs = z
  .object({ item_id: ItemId, quantity: Qty, modifiers: z.array(ModifierId).max(10) })
  .strict()
  .superRefine((a, ctx) => checkModifiers(a.item_id, a.modifiers, ctx, 'modifiers'));
export const RemoveItemArgs = z.object({ item_id: ItemId }).strict();
export const UpdateQuantityArgs = z.object({ item_id: ItemId, quantity: Qty }).strict();
export const ApplyModifierArgs = z
  .object({ item_id: ItemId, modifier: ModifierId })
  .strict()
  .superRefine((a, ctx) => checkModifiers(a.item_id, [a.modifier], ctx, 'modifier'));
export const ConfirmOrderArgs = z.object({ order_id: z.string().min(1), pickup_time: PickupTime }).strict();
export const GetOrderStateArgs = z.object({ order_id: z.string().min(1) }).strict();

export const TOOL_NAMES = ['add_item', 'remove_item', 'update_quantity', 'apply_modifier', 'confirm_order', 'get_order_state'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const TOOL_ARG_SCHEMAS = {
  add_item: AddItemArgs,
  remove_item: RemoveItemArgs,
  update_quantity: UpdateQuantityArgs,
  apply_modifier: ApplyModifierArgs,
  confirm_order: ConfirmOrderArgs,
  get_order_state: GetOrderStateArgs,
} as const;

export const MUTATING_TOOLS: readonly ToolName[] = ['add_item', 'remove_item', 'update_quantity', 'apply_modifier', 'confirm_order'];
export const isMutating = (t: string): boolean => (MUTATING_TOOLS as readonly string[]).includes(t);

/** Hold-mode for every mutating tool (DECISIONS D-01); get_order_state is read-only and interactive. */
export const executionMode = (t: ToolName): 'hold' | 'interactive' => (isMutating(t) ? 'hold' : 'interactive');

export type ValidationResult = { ok: true; args: Record<string, unknown> } | { ok: false; issues: string[] };

export function validateToolArgs(tool: string, args: unknown): ValidationResult {
  if (!(TOOL_NAMES as readonly string[]).includes(tool)) return { ok: false, issues: [`unknown tool ${tool}`] };
  const r = TOOL_ARG_SCHEMAS[tool as ToolName].safeParse(args);
  return r.success
    ? { ok: true, args: r.data as Record<string, unknown> }
    : { ok: false, issues: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}

/**
 * Model-facing declarations (the session tools list). `order_id` is NOT exposed to the model: Plane 1 injects
 * it, so the model can never target another order (SECURITY §5).
 */
export interface ToolDeclaration {
  type: 'function';
  name: ToolName;
  description: string;
  parameters: Record<string, unknown>;
  execution_mode: 'hold' | 'interactive';
  timeout_seconds: number;
}

const itemProp = { type: 'string', enum: MENU.map((m) => m.item_id), description: 'Menu item id, e.g. "burger", "fries", "coke".' };
const modEnum = { type: 'string', enum: ALL_MODIFIERS };

export function toolDeclarations(): ToolDeclaration[] {
  const d = (name: ToolName, description: string, properties: Record<string, unknown>, required: string[]): ToolDeclaration => ({
    type: 'function',
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    execution_mode: executionMode(name),
    timeout_seconds: 30,
  });
  return [
    d('add_item', 'Add an item to the order. Only call after the customer has clearly stated the item and quantity. If they correct themselves ("no wait, three"), use their FINAL stated quantity.', { item_id: itemProp, quantity: { type: 'integer', minimum: 1, maximum: 20 }, modifiers: { type: 'array', items: modEnum, description: 'Modifier ids valid for the item, e.g. "no_onions", "extra_cheese". Milkshake needs exactly one flavor_*.' } }, ['item_id', 'quantity', 'modifiers']),
    d('remove_item', 'Remove an item entirely from the order.', { item_id: itemProp }, ['item_id']),
    d('update_quantity', 'Change the quantity of an item already on the order to a new number (1-20).', { item_id: itemProp, quantity: { type: 'integer', minimum: 1, maximum: 20 } }, ['item_id', 'quantity']),
    d('apply_modifier', 'Apply one modifier to an item already on the order (e.g. "no_onions", "extra_cheese").', { item_id: itemProp, modifier: modEnum }, ['item_id', 'modifier']),
    d('confirm_order', 'Finalize the order once the customer says they are done and gives a pickup time ("ASAP" or ISO-8601 like 2026-09-19T18:30:00-04:00).', { pickup_time: { type: 'string', description: '"ASAP" or ISO-8601 datetime with offset.' } }, ['pickup_time']),
    d('get_order_state', 'Read the current order: items, quantities, modifiers and total. Use to read the order back to the customer.', {}, []),
  ];
}
