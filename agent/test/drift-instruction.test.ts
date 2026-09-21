// Step 10 (Plane 1): the wire wording of a spoken-drift correction, and totals that are recomputed, never repeated from storage.
import { describe, expect, it } from 'vitest';
import { escalationText, repairAsk, type RepairInstruction } from '@tally/contract';
import { driftInstruction, noopResult, okResult, orderStateResult } from '../src/repair-adapter.js';

const inst = (o: Partial<RepairInstruction> = {}): RepairInstruction => ({
  aai_call_id: 'speech:u1:burger', code: 'SPOKEN_STATE_DRIFT', item_id: 'burger', evidenced_value: '3', attempt: 1,
  ask_text: repairAsk('SPOKEN_STATE_DRIFT', { item_id: 'burger', evidenced_value: '3' }), ...o,
});

describe('driftInstruction (reply.create wording)', () => {
  it('tells the agent what is TRUE, that nothing changed, and not to call a tool; the spoken text is the scoped correction', () => {
    const w = driftInstruction(inst());
    expect(w).toContain('Your order has 3 classic burgers');
    expect(w).toMatch(/Nothing on the order has changed/);
    expect(w).toMatch(/Do not call any tool/);
    expect(w).not.toMatch(/_/);
  });

  it('the escalated variant forbids correcting again and hands off', () => {
    const w = driftInstruction(inst({ escalated: true, attempt: 3, ask_text: escalationText({ item_id: 'burger' }) }));
    expect(w).toMatch(/Do not try to correct it again/);
    expect(w).toMatch(/team member will confirm/);
    expect(w).toMatch(/Do not call any tool/);
  });

  it('total and not-on-order corrections read naturally', () => {
    expect(driftInstruction(inst({ code: 'TOTAL_MISMATCH', item_id: undefined, evidenced_value: '$26.97', ask_text: repairAsk('TOTAL_MISMATCH', { evidenced_value: '$26.97' }) }))).toContain('Your total is $26.97');
    expect(repairAsk('SPOKEN_STATE_DRIFT', { item_id: 'coke', evidenced_value: 'not_on_order' })).toBe("Let me correct that. I don't have any cokes on your order.");
  });
});

describe('totals are recomputed from the lines, never repeated from storage', () => {
  it('a wrong stored total_cents never reaches the agent', () => {
    const view = { lines: [{ item_id: 'burger', quantity: 3, modifiers: [] as string[] }], total_cents: 1, status: 'open' };
    for (const w of [okResult(view), orderStateResult(view), noopResult(view, 'x')]) expect(JSON.parse(w).total).toBe('$26.97');
  });
});
