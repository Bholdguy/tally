// Step 6: the adapter is the ONLY place a RepairInstruction becomes wire content. Data in, JSON out; scoped to the disputed item.
import { describe, expect, it } from 'vitest';
import { MENU, escalationText, repairAsk, type RepairInstruction } from '@tally/contract';
import { heldResult } from '../src/repair-adapter.js';

const inst = (o: Partial<RepairInstruction>): RepairInstruction => ({ aai_call_id: 'c1', code: 'QTY_MISMATCH', item_id: 'burger', evidenced_value: '3', ask_text: repairAsk('QTY_MISMATCH', { item_id: 'burger', evidenced_value: '3' }), attempt: 1, ...o });

describe('heldResult', () => {
  it('a normal repair tells the agent to ask exactly the scoped question and wait, changing nothing', () => {
    const r = JSON.parse(heldResult(inst({})));
    expect(r).toMatchObject({ status: 'HELD', code: 'QTY_MISMATCH' });
    expect(r.escalated).toBeUndefined();
    expect(r.instruction).toContain("Just to confirm, that's 3 classic burgers?");
    expect(r.instruction).toMatch(/Nothing was changed/);
    expect(r.instruction).toMatch(/do not call any tool until they reply/);
  });

  it('an escalated repair forbids re-asking and re-calling for that item, and tells the agent to carry on with the rest of the order', () => {
    for (const item of MENU) {
      const r = JSON.parse(heldResult(inst({ item_id: item.item_id, escalated: true, attempt: 3, ask_text: escalationText({ item_id: item.item_id }) })));
      expect(r).toMatchObject({ status: 'HELD', escalated: true });
      expect(r.instruction).toMatch(/Do not ask about it again/);
      expect(r.instruction).toMatch(/do not call a tool for it again/);
      expect(r.instruction).toMatch(/continue with the rest of the order/);
      expect(r.instruction).not.toMatch(/do not call any tool until they reply/);   // the other items MUST stay usable
    }
  });
});

// AUDIT (D-28): what the agent receives for narration must not push internal identifiers into speech.
import { CONFLICT_CODES } from '@tally/contract';
import { createGatedHandler } from '../src/gated-handler.js';
import { errorResult, noopResult, okResult, orderStateResult } from '../src/repair-adapter.js';

const view = { lines: [{ item_id: 'veggie_burger', quantity: 2, modifiers: ['no_onions', 'extra_cheese'] }, { item_id: 'fries', quantity: 1, modifiers: ['no_salt'] }], total_cents: 2597, status: 'open' };

describe('order results carry a `spoken` wording per line', () => {
  it('okResult / orderStateResult / noopResult: every line has `spoken` with no underscores or ids', () => {
    for (const w of [okResult(view), orderStateResult(view), noopResult(view, 'x')]) {
      const lines = JSON.parse(w).order as { spoken: string }[];
      expect(lines.map((l) => l.spoken)).toEqual(['2 veggie burgers with extra cheese and no onions', '1 order of french fries with no salt']);
      for (const l of lines) expect(l.spoken).not.toContain('_');
    }
  });
});

describe('errors: natural `message`, technical detail kept apart and labelled never-to-be-spoken', () => {
  it('no code, real or unknown, leaks ids or internal detail into `message`', () => {
    const technical = 'veggie_burger is not on the order; use update_quantity with no_onions';
    for (const code of ['ORDER_CLOSED', 'ALREADY_IN_ORDER', 'NOT_IN_ORDER', 'EMPTY_ORDER', 'INVALID', 'NOT_MUTATING', 'NO_ORDER', 'NO_STATE', ...CONFLICT_CODES, 'SOMETHING_NEW']) {
      const r = JSON.parse(errorResult(code, technical));
      expect(r.status).toBe('ERROR');
      expect(r.message).not.toMatch(/_|veggie|update_quantity|no_onions/);
      expect(r.message).not.toContain(technical);
      expect(r.agent_note).toMatch(/^For your own tool use only\. Never say this aloud: /);
    }
  });

  it('the gated handler word-for-word: a NOOP never forwards the gate\'s internal id-laden message; a misuse error keeps ids out of `message`', async () => {
    const st = { lines: [{ item_id: 'burger', quantity: 1, modifiers: ['no_onions'] }], status: 'open' as const };
    const gate = {
      readState: () => undefined,
      submit: async (c: { aai_call_id: string }) => c.aai_call_id === 'n'
        ? { verdict: 'ALLOW', noop: true, validation_event_id: 'v', actual_result: { state: st, total_cents: 899, message: 'no_onions is already applied to burger' } }
        : { verdict: 'HOLD', code: 'SCHEMA_INVALID', projection_error: 'NOT_IN_ORDER', validation_event_id: 'v', detail: 'NOT_IN_ORDER: cheeseburger is not on the order' },
    };
    const h = createGatedHandler(gate as never, 's');
    const noop = JSON.parse(await h({ aai_call_id: 'n', tool: 'apply_modifier', args: {}, received_t_ms: 0 } as never));
    expect(noop.status).toBe('NOOP');
    expect(noop.message).not.toMatch(/_/);
    const err = JSON.parse(await h({ aai_call_id: 'e', tool: 'remove_item', args: {}, received_t_ms: 0 } as never));
    expect(err).toMatchObject({ status: 'ERROR', code: 'NOT_IN_ORDER' });
    expect(err.message).not.toMatch(/_|cheeseburger/);
  });

  it('the system prompt forbids reading ids aloud and points the agent at `spoken`', async () => {
    const { buildSystemPrompt } = await import('../src/prompt.js');
    expect(buildSystemPrompt()).toMatch(/Never say item ids, option ids, error codes or tool names aloud/);
    expect(MENU.length).toBeGreaterThan(0);
  });
});
