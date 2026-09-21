/**
 * Plane 1 wrapper: the model is never told about order_id, and any model-supplied order_id is overwritten
 * (SECURITY §5: the model can never target another order).
 */
const NEEDS_ORDER_ID = new Set(['confirm_order', 'get_order_state']);

export function injectOrderId(tool: string, args: unknown, order_id: string): unknown {
  if (!NEEDS_ORDER_ID.has(tool)) return args;
  const base = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
  return { ...base, order_id };
}
