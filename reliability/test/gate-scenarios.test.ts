// Gate end-to-end scenarios at the timings measured in spike A, plus read-back (silent tool lie) and spoken-drift checks.
import { describe, expect, it } from 'vitest';
import { computeTotalCents } from '@tally/contract';
import { checkSpokenDrift } from '../src/drift.js';
import { makeRig } from './rig.js';

const B = (q: number) => ({ item_id: 'burger', quantity: q, modifiers: [] as string[] });

describe('scenario B at spike-A timings: the agent commits the stale quantity, the customer corrected to three', () => {
  it('WAITS on independent evidence (grey hold state), then HOLDS QTY_MISMATCH with a targeted repair; order untouched; then "yes three" -> ALLOWED, total 2697', async () => {
    const r = makeRig();
    r.up();
    r.final('2 burgers.');                                   // turn 0: the first utterance, finalised earlier
    // The customer starts the correction at t=0, the same instant the agent's stale tool call arrives (worst case measured in spike A).
    r.localStart();
    r.clock.at(600, () => r.speechStarted());                                  // independent SpeechStarted ~0.6 s after onset
    r.clock.at(1000, () => r.partial('No, wait,', { order: 1 }));
    r.clock.at(2000, () => r.partial('No, wait, make it 3.', { order: 1 }));
    r.clock.at(2700, () => r.localEnd());
    r.clock.at(3450, () => r.final('No, wait, make it 3.', { order: 1 })); // final ~1 s after speech end: the worst wait measured (3470 ms)
    const before = r.hash();

    const held = await r.call('add_item', B(2));
    expect(held).toMatchObject({ verdict: 'HOLD', code: 'QTY_MISMATCH', repair: { item_id: 'burger', evidenced_value: '3', ask_text: "Just to confirm, that's 3 classic burgers?" } });
    if (held.verdict !== 'HOLD') throw new Error('unreachable');
    expect(held.waited_ms!).toBeGreaterThanOrEqual(3450);       // the gate visibly waited for the independent final...
    expect(held.waited_ms!).toBeLessThan(4000);                 // ...and within the 4 s budget
    expect(r.hash()).toBe(before);                              // the order never contained the stale 2
    expect(r.store.getOrder(r.session)!.state.lines).toEqual([]);
    expect(r.toolCalls().at(-1)).toMatchObject({ tool_name: 'add_item', status: 'conflict', conflict_type: 'QTY_MISMATCH' });

    // repair loop (Step 6 owns attempts; here: the customer confirms and the agent re-issues with the corrected quantity)
    r.clock.advance(1500);
    r.final('Yes, three.', { order: 2 });
    const ok = await r.call('add_item', B(3));
    expect(ok.verdict).toBe('ALLOW');
    const order = r.store.getOrder(r.session)!;
    expect(order.state.lines).toEqual([{ item_id: 'burger', quantity: 3, modifiers: [] }]);
    expect(order.total_cents).toBe(2697);
    expect(order.total_cents).toBe(computeTotalCents(order.state.lines));
    r.close();
  });

  it('the FAST PATH: nobody speaking, evidence already final ⇒ no wait, ALLOW, waited_ms 0', async () => {
    const r = makeRig();
    r.up(); r.final('two burgers and a coke.');
    r.localStart(); r.clock.advance(300); r.speechStarted(); r.clock.advance(400); r.localEnd(); r.clock.advance(900); r.final('two burgers and a coke.', { order: 0 });
    // (the final above supersedes turn 0 with the finished utterance and lands after local speech ended)
    const res = await r.call('add_item', B(2));
    expect(res).toMatchObject({ verdict: 'ALLOW', waited_ms: 0 });
    r.close();
  });

  it('a correction that begins AFTER the call was allowed is handled by the next call: update_quantity(3) is validated on the new evidence', async () => {
    const r = makeRig();
    r.up(); r.final('two burgers.');
    expect((await r.call('add_item', B(2))).verdict).toBe('ALLOW');
    r.clock.advance(800);
    r.localStart(); r.clock.advance(500); r.speechStarted(); r.clock.advance(1500); r.localEnd(); r.clock.advance(900); r.final('No, wait, make it 3.', { order: 1 });
    const upd = await r.call('update_quantity', { item_id: 'burger', quantity: 3 });
    expect(upd.verdict).toBe('ALLOW');
    expect(r.store.getOrder(r.session)!.total_cents).toBe(2697);
    r.close();
  });

  it('a stale update after the correction is held (agent says 2, customer said 3)', async () => {
    const r = makeRig();
    r.up(); r.final('three burgers.');
    r.seed({ tool: 'add_item', args: B(3) });
    const before = r.hash();
    const res = await r.call('update_quantity', { item_id: 'burger', quantity: 2 });
    expect(res).toMatchObject({ verdict: 'HOLD', code: 'QTY_MISMATCH' });
    expect(r.hash()).toBe(before);
    r.close();
  });
});

describe('read-back: a tool that lies about its result is caught (TOOL_RESULT_LIE)', () => {
  it('committer reports a different quantity than the database holds: flagged, HOLD, incident audited', async () => {
    const r = makeRig({});
    let holder!: ReturnType<typeof makeRig>;
    holder = makeRig({
      commit: (allow, req) => {
        const real = holder.store.commit(allow, req);
        return real.ok ? { ...real, state: { ...real.state, lines: real.state.lines.map((l) => ({ ...l, quantity: l.quantity + 1 })) } } : real; // reports 3 while the DB wrote 2
      },
    });
    holder.up(); holder.final('two burgers.');
    const res = await holder.call('add_item', B(2));
    expect(res).toMatchObject({ verdict: 'HOLD', code: 'TOOL_RESULT_LIE' });
    expect(holder.toolCalls().at(-1)).toMatchObject({ status: 'conflict', conflict_type: 'TOOL_RESULT_LIE' });
    const incident = holder.store.r.prepare("SELECT count(*) c FROM audit_events WHERE action='incident:TOOL_RESULT_LIE'").get() as { c: number };
    expect(incident.c).toBe(1);
    r.close(); holder.close();
  });

  it('committer reports a different TOTAL than the database holds', async () => {
    let h!: ReturnType<typeof makeRig>;
    h = makeRig({ commit: (a, q) => { const real = h.store.commit(a, q); return real.ok ? { ...real, total_cents: real.total_cents + 100 } : real; } });
    h.up(); h.final('two burgers.');
    expect(await h.call('add_item', B(2))).toMatchObject({ verdict: 'HOLD', code: 'TOOL_RESULT_LIE' });
    h.close();
  });

  it('committer claims success but wrote nothing (silent lie): caught by the read-back', async () => {
    let h!: ReturnType<typeof makeRig>;
    h = makeRig({ commit: (_a, q) => ({ ok: true, tool_call_id: 'tc_fake', state: { lines: [{ item_id: 'burger', quantity: 2, modifiers: [] }], status: 'open', pickup_time: null }, total_cents: 1798 }) });
    h.up(); h.final('two burgers.');
    const res = await h.call('add_item', B(2));
    expect(res).toMatchObject({ verdict: 'HOLD', code: 'TOOL_RESULT_LIE' });
    expect(h.store.getOrder(h.session)!.state.lines).toEqual([]);   // the database is the truth, and it is empty
    h.close();
  });

  it('an honest committer passes the read-back', async () => {
    const r = makeRig();
    r.up(); r.final('two burgers.');
    expect((await r.call('add_item', B(2))).verdict).toBe('ALLOW');
    r.close();
  });
});

describe('spoken-state drift: the agent\'s words are checked against the committed order, never trusted', () => {
  const order = (lines: { item_id: string; quantity: number }[]) => {
    const full = lines.map((l) => ({ ...l, modifiers: [] as string[] }));
    return { lines: full, total_cents: computeTotalCents(full) };
  };
  it('agent says "two burgers" but the order has three: SPOKEN_STATE_DRIFT', () => {
    expect(checkSpokenDrift('Got it, two classic burgers. Anything else for you?', order([{ item_id: 'burger', quantity: 3 }]))).toEqual([expect.objectContaining({ code: 'SPOKEN_STATE_DRIFT', item_id: 'burger' })]);
  });
  it('the spike-g5 failure: the agent confirmed the stale quantity aloud', () => {
    expect(checkSpokenDrift("I have two classic burgers on your order. Would you like to add anything else?", order([{ item_id: 'burger', quantity: 3 }])).map((f) => f.code)).toEqual(['SPOKEN_STATE_DRIFT']);
  });
  it('a correct confirmation produces no finding', () => {
    expect(checkSpokenDrift('Got it, three burgers. Anything else?', order([{ item_id: 'burger', quantity: 3 }]))).toEqual([]);
  });
  it('questions and offers make no claim', () => {
    expect(checkSpokenDrift('Would you like two fries with that?', order([]))).toEqual([]);
  });
  it('a claimed item that is not on the order is drift', () => {
    expect(checkSpokenDrift("Okay, I've added two cokes.", order([{ item_id: 'burger', quantity: 1 }])).map((f) => f.code)).toEqual(['SPOKEN_STATE_DRIFT']);
  });
  it('a wrong total is TOTAL_MISMATCH; the right total is not', () => {
    const o = order([{ item_id: 'burger', quantity: 3 }]);      // 2697
    expect(checkSpokenDrift('Your total is $25.97.', o).map((f) => f.code)).toEqual(['TOTAL_MISMATCH']);
    expect(checkSpokenDrift('Your total is $26.97.', o)).toEqual([]);
  });
  it('gate.onAgentSpeech audits findings and never writes to orders', async () => {
    const r = makeRig();
    r.up(); r.final('three burgers.');
    r.seed({ tool: 'add_item', args: B(3) });
    const before = r.hash();
    const findings = r.gate.onAgentSpeech(r.session, 'Got it, two classic burgers.');
    expect(findings.map((f) => f.code)).toEqual(['SPOKEN_STATE_DRIFT']);
    expect(r.hash()).toBe(before);
    expect((r.store.r.prepare("SELECT count(*) c FROM audit_events WHERE action='drift:SPOKEN_STATE_DRIFT'").get() as { c: number }).c).toBe(1);
    r.close();
  });
});

describe('confirm-time reconciliation (D-22): the order about to be confirmed must equal what the customer said', () => {
  const add = (item_id: string, quantity: number, modifiers: string[] = []) => ({ tool: 'add_item', args: { item_id, quantity, modifiers } });

  it('THE HOLE spike A exposed: stale 2 was allowed (correction began after the call), agent never fixed it, confirm is HELD; after the fix it confirms', async () => {
    const r = makeRig();
    r.up(); r.final('2 burgers.');
    expect((await r.call('add_item', B(2))).verdict).toBe('ALLOW');                 // correct at decision time
    r.clock.advance(300); r.localStart(); r.clock.advance(600); r.speechStarted(); r.clock.advance(1500); r.localEnd(); r.clock.advance(1300);
    r.final('No, wait, make it 3.', { order: 1 });
    r.clock.advance(600); r.final('That is all. Pick up as soon as possible.', { order: 2 });
    const before = r.hash();
    const held = await r.call('confirm_order', { order_id: 'x', pickup_time: 'ASAP' });
    expect(held).toMatchObject({ verdict: 'HOLD', code: 'QTY_MISMATCH', repair: { item_id: 'burger', evidenced_value: '3' } });
    expect(r.hash()).toBe(before);
    expect(r.store.getOrder(r.session)!.state.status).toBe('open');                 // NOT confirmed
    expect((await r.call('update_quantity', { item_id: 'burger', quantity: 3 })).verdict).toBe('ALLOW');
    const ok = await r.call('confirm_order', { order_id: 'x', pickup_time: 'ASAP' });
    expect(ok.verdict).toBe('ALLOW');
    const o = r.store.getOrder(r.session)!;
    expect(o.state.status).toBe('confirmed');
    expect(o.state.lines).toEqual([{ item_id: 'burger', quantity: 3, modifiers: [] }]);
    expect(o.total_cents).toBe(2697);
    r.close();
  });

  it('confirm is held when an item the customer never asked for is on the order', async () => {
    const r = makeRig();
    r.up(); r.final('a burger, pickup as soon as possible');
    r.seed(add('burger', 1), add('coke', 1));
    expect(await r.call('confirm_order', { order_id: 'x', pickup_time: 'ASAP' })).toMatchObject({ verdict: 'HOLD', code: 'UNSUPPORTED_CLAIM' });
    r.close();
  });

  it('confirm is held when the customer asked for an item that is not on the order', async () => {
    const r = makeRig();
    r.up(); r.final('a burger and fries, pickup as soon as possible');
    r.seed(add('burger', 1));
    expect(await r.call('confirm_order', { order_id: 'x', pickup_time: 'ASAP' })).toMatchObject({ verdict: 'HOLD', code: 'ITEM_MISMATCH' });
    r.close();
  });

  it('confirm is held on a modifier mismatch in either direction', async () => {
    const r1 = makeRig();
    r1.up(); r1.final('a burger no onions, pickup as soon as possible');
    r1.seed(add('burger', 1));
    expect(await r1.call('confirm_order', { order_id: 'x', pickup_time: 'ASAP' })).toMatchObject({ verdict: 'HOLD', code: 'REMOVAL_MISMATCH' });
    const r2 = makeRig();
    r2.up(); r2.final('a burger, pickup as soon as possible');
    r2.seed(add('burger', 1, ['extra_cheese']));
    expect(await r2.call('confirm_order', { order_id: 'x', pickup_time: 'ASAP' })).toMatchObject({ verdict: 'HOLD', code: 'MODIFIER_MISMATCH' });
    r1.close(); r2.close();
  });

  it('confirm is held when the customer removed an item that is still on the order', async () => {
    const r = makeRig();
    r.up(); r.final('a burger and fries'); r.final('cancel the fries, pickup as soon as possible', { order: 1 } as never);
    r.seed(add('burger', 1), add('fries', 1));
    expect(await r.call('confirm_order', { order_id: 'x', pickup_time: 'ASAP' })).toMatchObject({ verdict: 'HOLD', code: 'REMOVAL_MISMATCH' });
    r.close();
  });

  it('an order that exactly matches the evidence confirms, and the total is recomputed from the menu', async () => {
    const r = makeRig();
    r.up(); r.final('two burgers and a coke, pickup as soon as possible');
    r.seed(add('burger', 2), add('coke', 1));
    expect((await r.call('confirm_order', { order_id: 'x', pickup_time: 'ASAP' })).verdict).toBe('ALLOW');
    expect(r.store.getOrder(r.session)!.total_cents).toBe(2047);
    r.close();
  });
});
