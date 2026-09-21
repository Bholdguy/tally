import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { computeTotalCents } from '@tally/contract';
import { initDatabase, openAdmin } from '@tally/db';
import { Store } from '../src/committer.js';
import { mintAllow } from '../src/decision.js';
import { applyTool, emptyOrder } from '../src/order.js';

const stores: Store[] = [];
function setup() {
  const p = join(mkdtempSync(join(tmpdir(), 'tally-c-')), 't.sqlite');
  initDatabase(p);
  const s = new Store(p);
  stores.push(s);
  s.createSession({ id: 's1', mode: 'demo', config_version: 'v1' });
  s.openOrder('s1');
  return { s, p };
}
afterEach(() => { while (stores.length) stores.pop()!.close(); });

const orderHash = (s: Store) => createHash('sha256').update(JSON.stringify(s.r.prepare('SELECT * FROM orders').all())).digest('hex');
const auditCount = (s: Store) => (s.r.prepare('SELECT count(*) c FROM audit_events').get() as { c: number }).c;

let n = 0;
const call = (tool: string, args: Record<string, unknown>) => ({ session_id: 's1', aai_call_id: `c${++n}`, tool, args, execution_mode: 'hold' as const });
const allow = (c: { session_id: string; aai_call_id: string }) => mintAllow(`val_${c.aai_call_id}`, c.session_id, c.aai_call_id);

describe('commit path (rule 8)', () => {
  it('scenario A: 2 burgers + coke commits, total 2047, every change has an audit pair', () => {
    const { s } = setup();
    const c1 = call('add_item', { item_id: 'burger', quantity: 2, modifiers: [] });
    const c2 = call('add_item', { item_id: 'coke', quantity: 1, modifiers: [] });
    expect(s.commit(allow(c1), c1)).toMatchObject({ ok: true });
    expect(s.commit(allow(c2), c2)).toMatchObject({ ok: true, total_cents: 2047 });
    const o = s.getOrder('s1')!;
    expect(o.state.lines).toEqual([{ item_id: 'burger', quantity: 2, modifiers: [] }, { item_id: 'coke', quantity: 1, modifiers: [] }]);
    expect(o.total_cents).toBe(computeTotalCents(o.state.lines));
    const unpaired = s.r.prepare(`SELECT count(*) c FROM tool_calls t WHERE NOT EXISTS (SELECT 1 FROM audit_events a WHERE a.tool_call_id=t.id AND a.validation_event_id=t.validation_event_id)`).get() as { c: number };
    expect(unpaired.c).toBe(0);
  });

  it('scenario B end state: update to 3 gives 2697', () => {
    const { s } = setup();
    const a = call('add_item', { item_id: 'burger', quantity: 2, modifiers: [] });
    s.commit(allow(a), a);
    const u = call('update_quantity', { item_id: 'burger', quantity: 3 });
    expect(s.commit(allow(u), u)).toMatchObject({ ok: true, total_cents: 2697 });
  });

  it('a failed projection writes nothing (orders + audit unchanged)', () => {
    const { s } = setup();
    const before = orderHash(s);
    const auditBefore = auditCount(s);
    const bad = call('update_quantity', { item_id: 'burger', quantity: 3 }); // not in order
    expect(s.commit(allow(bad), bad)).toMatchObject({ ok: false, error_code: 'NOT_IN_ORDER' });
    expect(orderHash(s)).toBe(before);
    expect(auditCount(s)).toBe(auditBefore);
    expect((s.r.prepare('SELECT count(*) c FROM tool_calls').get() as any).c).toBe(0);
  });

  it('rejects an AllowDecision that belongs to a different tool call', () => {
    const { s } = setup();
    const a = call('add_item', { item_id: 'burger', quantity: 2, modifiers: [] });
    const other = call('add_item', { item_id: 'coke', quantity: 1, modifiers: [] });
    expect(s.commit(allow(other), a)).toMatchObject({ ok: false, error_code: 'DECISION_MISMATCH' });
    expect(s.getOrder('s1')!.state.lines).toEqual([]);
  });
});

describe('database-level enforcement of the write path', () => {
  it('a direct UPDATE on orders without a new, paired validation event is aborted', () => {
    const { s, p } = setup();
    const a = call('add_item', { item_id: 'burger', quantity: 2, modifiers: [] });
    s.commit(allow(a), a);
    const rogue = openAdmin(p); // even a full-privilege handle cannot bypass the trigger
    expect(() => rogue.prepare("UPDATE orders SET items_json='[]', total=0").run()).toThrow(/validation_event_id/);
    expect(() => rogue.prepare("UPDATE orders SET total=1, last_validation_event_id='forged'").run()).toThrow(/validation_event_id/);
    rogue.close();
    expect(s.getOrder('s1')!.total_cents).toBe(1798);
  });
  it('orders cannot be deleted; events_raw and audit_events are append-only', () => {
    const { s, p } = setup();
    s.insertEventRaw({ id: 'e1', session_id: 's1', direction: 'in', type: 'x', payload: {}, t_ms: 1 });
    const rogue = openAdmin(p);
    expect(() => rogue.prepare('DELETE FROM orders').run()).toThrow(/never deleted/);
    expect(() => rogue.prepare("UPDATE events_raw SET type='y'").run()).toThrow(/append-only/);
    expect(() => rogue.prepare('DELETE FROM events_raw').run()).toThrow(/append-only/);
    expect(() => rogue.prepare("UPDATE audit_events SET action='x'").run()).toThrow(/append-only/);
    expect(() => rogue.prepare('DELETE FROM audit_events').run()).toThrow(/append-only/);
    rogue.close();
  });
  it('configs are insert-only for content (rule 4)', () => {
    const { p } = setup();
    const a = openAdmin(p);
    a.prepare("INSERT INTO configs(id,version,prompt_hash,tool_schema_hash,created_at,prompt_text,tool_schema_json) VALUES('c1','v1','h','h',1,'prompt','[]')").run();
    expect(() => a.prepare("UPDATE configs SET prompt_text='changed' WHERE version='v1'").run()).toThrow(/immutable/);
    expect(() => a.prepare("UPDATE configs SET promoted=1 WHERE version='v1'").run()).not.toThrow();
    expect(() => a.prepare("DELETE FROM configs").run()).toThrow(/never deleted/);
    a.close();
  });
});

describe('duplicate tool calls (D-20)', () => {
  it('replaying the same aai_call_id is idempotent: no second audit row, no second tool_calls row, order unchanged', () => {
    const { s } = setup();
    const a = call('add_item', { item_id: 'burger', quantity: 2, modifiers: [] });
    expect(s.commit(allow(a), a)).toMatchObject({ ok: true });
    const auditAfterFirst = auditCount(s);
    const before = orderHash(s);
    const replay = s.commit(allow(a), a);
    expect(replay).toMatchObject({ ok: true, idempotent: true });
    expect(auditCount(s)).toBe(auditAfterFirst);
    expect(orderHash(s)).toBe(before);
    expect((s.r.prepare('SELECT count(*) c FROM tool_calls').get() as any).c).toBe(1);
  });
  it('the clean-scenario duplicate add_item(coke) (a NEW call id, same args) is NO_CHANGE and writes nothing', () => {
    const { s } = setup();
    const a = call('add_item', { item_id: 'coke', quantity: 1, modifiers: [] });
    s.commit(allow(a), a);
    const before = orderHash(s);
    const dupe = call('add_item', { item_id: 'coke', quantity: 1, modifiers: [] });
    expect(s.commit(allow(dupe), dupe)).toMatchObject({ ok: false, error_code: 'NO_CHANGE' });
    expect(orderHash(s)).toBe(before);
    expect((s.r.prepare('SELECT count(*) c FROM tool_calls').get() as any).c).toBe(1);
  });
  it('add_item on an existing item with DIFFERENT args stays a conflict (ALREADY_IN_ORDER), not a no-op', () => {
    const r1 = applyTool(emptyOrder(), 'add_item', { item_id: 'coke', quantity: 1, modifiers: [] });
    if (!r1.ok) throw new Error('setup');
    expect(applyTool(r1.state, 'add_item', { item_id: 'coke', quantity: 1, modifiers: ['size_large'] })).toMatchObject({ ok: false, error_code: 'ALREADY_IN_ORDER' });
    expect(applyTool(r1.state, 'add_item', { item_id: 'coke', quantity: 2, modifiers: [] })).toMatchObject({ ok: false, error_code: 'ALREADY_IN_ORDER' });
  });
  it('no-op update_quantity and apply_modifier are NO_CHANGE (no audit-paired no-op commits)', () => {
    const r1 = applyTool(emptyOrder(), 'add_item', { item_id: 'burger', quantity: 3, modifiers: ['no_onions'] });
    if (!r1.ok) throw new Error('setup');
    expect(applyTool(r1.state, 'update_quantity', { item_id: 'burger', quantity: 3 })).toMatchObject({ ok: false, error_code: 'NO_CHANGE' });
    expect(applyTool(r1.state, 'apply_modifier', { item_id: 'burger', modifier: 'no_onions' })).toMatchObject({ ok: false, error_code: 'NO_CHANGE' });
    expect(applyTool(r1.state, 'update_quantity', { item_id: 'burger', quantity: 2 })).toMatchObject({ ok: true });
  });
  it('modifier order does not defeat duplicate detection', () => {
    const r1 = applyTool(emptyOrder(), 'add_item', { item_id: 'burger', quantity: 1, modifiers: ['no_onions', 'extra_cheese'] });
    if (!r1.ok) throw new Error('setup');
    expect(applyTool(r1.state, 'add_item', { item_id: 'burger', quantity: 1, modifiers: ['extra_cheese', 'no_onions'] })).toMatchObject({ ok: false, error_code: 'NO_CHANGE' });
  });
});

describe('order projection (pure)', () => {
  it('add_item on an existing item is rejected: use update_quantity', () => {
    const s0 = applyTool(emptyOrder(), 'add_item', { item_id: 'burger', quantity: 2, modifiers: [] });
    expect(s0.ok).toBe(true);
    if (!s0.ok) return;
    expect(applyTool(s0.state, 'add_item', { item_id: 'burger', quantity: 3, modifiers: [] })).toMatchObject({ ok: false, error_code: 'ALREADY_IN_ORDER' });
  });
  it('modifiers: exclusive groups replace, deltas price correctly', () => {
    let st = emptyOrder();
    for (const [t, a] of [
      ['add_item', { item_id: 'coke', quantity: 1, modifiers: ['size_small'] }],
      ['apply_modifier', { item_id: 'coke', modifier: 'size_large' }],
      ['add_item', { item_id: 'burger', quantity: 2, modifiers: [] }],
      ['apply_modifier', { item_id: 'burger', modifier: 'extra_cheese' }],
    ] as const) {
      const r = applyTool(st, t, a as any);
      expect(r.ok).toBe(true);
      if (r.ok) st = r.state;
    }
    expect(st.lines.find((l) => l.item_id === 'coke')!.modifiers).toEqual(['size_large']);
    expect(computeTotalCents(st.lines)).toBe(249 + 75 + 2 * (899 + 100));
  });
  it('confirm_order: needs items; closes the order; later mutations rejected', () => {
    expect(applyTool(emptyOrder(), 'confirm_order', { order_id: 'o', pickup_time: 'ASAP' })).toMatchObject({ ok: false, error_code: 'EMPTY_ORDER' });
    const a = applyTool(emptyOrder(), 'add_item', { item_id: 'fries', quantity: 1, modifiers: [] });
    if (!a.ok) throw new Error('setup');
    const c = applyTool(a.state, 'confirm_order', { order_id: 'o', pickup_time: 'ASAP' });
    expect(c).toMatchObject({ ok: true });
    if (!c.ok) return;
    expect(c.state.status).toBe('confirmed');
    expect(applyTool(c.state, 'remove_item', { item_id: 'fries' })).toMatchObject({ ok: false, error_code: 'ORDER_CLOSED' });
  });
  it('remove_item / get_order_state semantics', () => {
    expect(applyTool(emptyOrder(), 'remove_item', { item_id: 'fries' })).toMatchObject({ ok: false, error_code: 'NOT_IN_ORDER' });
    expect(applyTool(emptyOrder(), 'get_order_state', { order_id: 'o' })).toMatchObject({ ok: false, error_code: 'NOT_MUTATING' });
  });
});
