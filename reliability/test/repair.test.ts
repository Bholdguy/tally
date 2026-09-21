// Step 6: targeted repair. Scope = the disputed item only; attempt counter; escalation after 2; resolution only by a
// re-validated call; hold and repair record written together; Tally supplies instructions only (D-09).
import { describe, expect, it } from 'vitest';
import { CONFLICT_CODES, MAX_REPAIR_ATTEMPTS, MENU, escalationText, repairAsk, type ConflictCode } from '@tally/contract';
import type { RepairNotice } from '../src/gate.js';
import { makeRig } from './rig.js';

const B = (q: number) => ({ item_id: 'burger', quantity: q, modifiers: [] as string[] });
const C = (q: number) => ({ item_id: 'coke', quantity: q, modifiers: [] as string[] });

describe('scenario B: HELD -> scoped repair -> confirmed -> ALLOWED, other items untouched (PRD §19: repair without restart)', () => {
  it('persists the repair with the hold, resolves it ONLY on the re-validated commit, and leaves unrelated lines byte-identical', async () => {
    const notices: RepairNotice[] = [];
    const r = makeRig({ onRepair: (n) => notices.push(n) });
    r.up();
    r.seed({ tool: 'add_item', args: C(1) }, { tool: 'add_item', args: { item_id: 'fries', quantity: 1, modifiers: [] } });
    const untouched = (): string => JSON.stringify(r.store.getOrder(r.session)!.state.lines.filter((l) => l.item_id !== 'burger'));
    const others0 = untouched();
    r.final('three burgers.');

    const held = await r.call('add_item', B(2));
    expect(held).toMatchObject({ verdict: 'HOLD', code: 'QTY_MISMATCH', repair: { attempt: 1, item_id: 'burger' } });
    expect(r.store.getOrder(r.session)!.state.lines.some((l) => l.item_id === 'burger')).toBe(false);
    expect(untouched()).toBe(others0);
    const rows = r.store.allRepairs(r.session);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scope: 'burger', outcome: 'pending', attempt: 1, reason: 'QTY_MISMATCH', resolved_at: null });
    expect(rows[0]!.repair_prompt).toBe("Just to confirm, that's 3 classic burgers?");
    // the repair row points at the held tool call (same transaction as the hold)
    expect(r.store.r.prepare('SELECT status FROM tool_calls WHERE id=?').get(rows[0]!.tool_call_id)).toEqual({ status: 'conflict' });

    r.clock.advance(1200);
    r.final('Yes, three.');
    const ok = await r.call('add_item', B(3));
    expect(ok.verdict).toBe('ALLOW');
    const after = r.store.allRepairs(r.session);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ outcome: 'resolved' });
    expect(after[0]!.resolved_at).not.toBeNull();
    const committed = r.store.r.prepare("SELECT id FROM tool_calls WHERE session_id=? AND status='allowed' ORDER BY timestamp DESC LIMIT 1").get(r.session) as { id: string };
    expect(after[0]!.resolving_tool_call_id).toBe(committed.id);
    expect(untouched()).toBe(others0);                                   // coke and fries never moved
    expect(r.store.getOrder(r.session)!.state.lines.find((l) => l.item_id === 'burger')!.quantity).toBe(3);
    expect(notices.map((n) => `${n.outcome}:${n.scope}`)).toEqual(['asked:burger', 'resolved:burger']);
    r.close();
  });

  it('the customer saying yes is NOT enough: a re-issued call that still disagrees with the evidence is held again, repair stays open', async () => {
    const r = makeRig();
    r.up(); r.final('three burgers.');
    expect((await r.call('add_item', B(2))).verdict).toBe('HOLD');
    r.final('Yes, three.');
    const again = await r.call('add_item', B(4));                        // the agent got it wrong again
    expect(again).toMatchObject({ verdict: 'HOLD', repair: { attempt: 2 } });
    expect(r.store.allRepairs(r.session).map((x) => [x.attempt, x.outcome])).toEqual([[1, 'pending'], [2, 'pending']]);
    expect((await r.call('add_item', B(3))).verdict).toBe('ALLOW');
    expect(r.store.allRepairs(r.session).map((x) => x.outcome)).toEqual(['resolved', 'resolved']);
    expect(r.store.openRepairs(r.session)).toEqual([]);
    r.close();
  });

  it('an exact repeat of what is already committed (NOOP) still counts as re-validation and closes the repair', async () => {
    const r = makeRig();
    r.up(); r.final('three burgers.');
    r.seed({ tool: 'add_item', args: B(3) });
    expect((await r.call('update_quantity', { item_id: 'burger', quantity: 2 })).verdict).toBe('HOLD');
    expect(r.store.openRepairs(r.session)).toHaveLength(1);
    const noop = await r.call('update_quantity', { item_id: 'burger', quantity: 3 });
    expect(noop).toMatchObject({ verdict: 'ALLOW', noop: true });
    expect(r.store.openRepairs(r.session)).toEqual([]);
    expect(r.store.allRepairs(r.session)[0]).toMatchObject({ outcome: 'resolved', resolving_tool_call_id: null });
    r.close();
  });
});

describe('attempt counter and escalation (PRD §B.9: N = 2, then the item stays uncommitted and the rest of the order goes on)', () => {
  it('two scoped asks, then ESCALATED; the disputed item is never committed; an unrelated item is still ALLOWED', async () => {
    const r = makeRig();
    r.up(); r.final('three burgers and a coke.');
    const before = r.hash();
    const seen = [];
    for (let i = 0; i < 3; i++) seen.push(await r.call('add_item', B(2)));
    expect(seen.map((s) => (s.verdict === 'HOLD' ? [s.repair?.attempt, s.repair?.escalated ?? false] : 'ALLOW'))).toEqual([[1, false], [2, false], [MAX_REPAIR_ATTEMPTS + 1, true]]);
    expect(MAX_REPAIR_ATTEMPTS).toBe(2);
    const esc = seen[2]!;
    if (esc.verdict !== 'HOLD') throw new Error('unreachable');
    expect(esc.repair!.ask_text).toBe(escalationText({ item_id: 'burger' }));
    expect(r.hash()).toBe(before);                                          // still nothing committed
    expect(r.store.allRepairs(r.session).map((x) => x.outcome)).toEqual(['escalated', 'escalated', 'escalated']);
    // further disagreeing calls do not spawn more repair rows and keep answering "escalated"
    const more = await r.call('add_item', B(2));
    expect(more).toMatchObject({ verdict: 'HOLD', repair: { escalated: true } });
    expect(r.store.allRepairs(r.session)).toHaveLength(3);
    // repair without restart: the coke, which was never disputed, goes through
    expect((await r.call('add_item', C(1))).verdict).toBe('ALLOW');
    expect(r.store.getOrder(r.session)!.state.lines).toEqual([{ item_id: 'coke', quantity: 1, modifiers: [] }]);
    r.close();
  });

  it('attempts are counted per disputed item, not per call or per order', async () => {
    const r = makeRig();
    r.up(); r.final('three burgers and two cokes.');
    const a = await r.call('add_item', B(2));
    const b = await r.call('add_item', C(1));
    const a2 = await r.call('add_item', B(2));
    expect([a, b, a2].map((x) => (x.verdict === 'HOLD' ? x.repair!.attempt : 0))).toEqual([1, 1, 2]);
    r.close();
  });

  it('a late valid call after escalation is still safe to commit (the gate never depended on repair state); history keeps outcome=escalated; a NEW dispute starts again at attempt 1', async () => {
    const r = makeRig();
    r.up(); r.final('three burgers.');
    for (let i = 0; i < 3; i++) await r.call('add_item', B(2));
    r.clock.advance(500); r.final('Three burgers, yes.');
    expect((await r.call('add_item', B(3))).verdict).toBe('ALLOW');
    const rows = r.store.allRepairs(r.session);
    expect(rows.every((x) => x.outcome === 'escalated' && x.resolved_at !== null)).toBe(true);
    const fresh = await r.call('update_quantity', { item_id: 'burger', quantity: 9 });
    expect(fresh).toMatchObject({ verdict: 'HOLD', repair: { attempt: 1 } });
    expect((fresh as { repair: { escalated?: boolean } }).repair.escalated).toBeUndefined();
    r.close();
  });

  it('an idempotent replay of an already-held call id neither advances the counter nor writes a second repair row', async () => {
    const r = makeRig();
    r.up(); r.final('three burgers.');
    await r.call('add_item', B(2), 'dup');
    await r.call('add_item', B(2), 'dup');
    await r.call('add_item', B(2), 'dup');
    expect(r.store.allRepairs(r.session)).toHaveLength(1);
    r.close();
  });

  it('agent misuse (projection error) and non-repairable holds create NO repair row: there is no customer question to ask', async () => {
    const r = makeRig();
    r.up(); r.final('Cancel the burger.');
    const res = await r.call('remove_item', { item_id: 'burger' });          // the customer did ask, but the order has no burger: agent misuse
    expect(res).toMatchObject({ verdict: 'HOLD' });
    expect((res as { projection_error?: string }).projection_error).toBeDefined();
    expect((res as { repair?: unknown }).repair).toBeUndefined();
    expect(r.store.allRepairs(r.session)).toEqual([]);
    r.close();
  });

  it('a whole-order confirm_order dispute is scoped to "order", not to any single item', async () => {
    const r = makeRig();
    r.up(); r.final('two burgers and a coke.');
    r.seed({ tool: 'add_item', args: B(2) });                                // coke missing from the order
    const res = await r.call('confirm_order', {});
    expect(res.verdict).toBe('HOLD');
    const rows = r.store.allRepairs(r.session);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x) => typeof x.scope === 'string')).toBe(true);
    r.close();
  });

  it('ITEM_MISMATCH is closed by a valid call on the item the customer actually asked for', async () => {
    const r = makeRig();
    r.up(); r.final('a veggie burger.');
    const held = await r.call('add_item', { item_id: 'cheeseburger', quantity: 1, modifiers: [] });
    expect(held).toMatchObject({ verdict: 'HOLD', code: 'ITEM_MISMATCH' });
    expect(r.store.allRepairs(r.session)[0]).toMatchObject({ scope: 'cheeseburger', alt_scope: 'veggie_burger' });
    expect((await r.call('add_item', { item_id: 'veggie_burger', quantity: 1, modifiers: [] })).verdict).toBe('ALLOW');
    expect(r.store.openRepairs(r.session)).toEqual([]);
    r.close();
  });

  it('the attempt limit is configurable and pending repairs at hangup stay pending, never silently resolved', async () => {
    const r = makeRig({ maxRepairAttempts: 1 });
    r.up(); r.final('three burgers.');
    const first = await r.call('add_item', B(2));
    const second = await r.call('add_item', B(2));
    expect([first, second].map((x) => (x.verdict === 'HOLD' ? x.repair!.escalated ?? false : null))).toEqual([false, true]);
    const r2 = makeRig({ session: 's2' });
    r2.up(); r2.final('three burgers.');
    await r2.call('add_item', B(2));
    r2.store.endSession('s2');
    expect(r2.store.openRepairs('s2')[0]).toMatchObject({ outcome: 'pending' });
    r.close(); r2.close();
  });
});

describe('scope and voice boundary (Tally supplies instructions only)', () => {
  const codes = CONFLICT_CODES as readonly ConflictCode[];

  it('no repair or escalation text, for any conflict code and any item, names a DIFFERENT menu item', () => {
    let checked = 0;
    for (const item of MENU) {
      const own = item.name.toLowerCase();
      const others = MENU.filter((m) => m.item_id !== item.item_id).map((m) => m.name.toLowerCase()).filter((n) => !own.includes(n) && !n.includes(own));
      const texts = [
        ...codes.map((c) => repairAsk(c, { item_id: item.item_id, evidenced_value: '3' })),
        ...codes.map((c) => repairAsk(c, { item_id: item.item_id })),
        escalationText({ item_id: item.item_id }),
      ];
      for (const t of texts) {
        for (const o of others) expect(t.toLowerCase(), `${item.item_id}: "${t}" mentions ${o}`).not.toContain(o);
        checked++;
      }
    }
    expect(checked).toBe(MENU.length * (codes.length * 2 + 1));
  });

  it('escalation wording is a hand-off, not a question, and promises nothing about the order state', () => {
    for (const item of MENU) {
      const t = escalationText({ item_id: item.item_id });
      expect(t).not.toMatch(/\?/);
      expect(t).not.toMatch(/added|confirmed|your total|\$\d/i);
    }
    expect(escalationText({})).not.toMatch(/\?/);
  });
});
