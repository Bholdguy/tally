import { describe, expect, it } from 'vitest';
import {
  ALL_MODIFIERS, CONFLICT_CODES, MENU, MUTATING_TOOLS, TOOL_NAMES, TallyEvent, computeTotalCents,
  executionMode, getItem, isAllowedModifier, modifierClass, repairAsk, toolDeclarations, validateToolArgs,
} from '../src/index.js';
import { CONFLICT_FIXTURES } from './conflict-fixtures.js';

const ISO = '2026-09-19T18:30:00-04:00';

const VALID: Record<string, unknown[]> = {
  add_item: [
    { item_id: 'burger', quantity: 2, modifiers: [] },
    { item_id: 'burger', quantity: 1, modifiers: ['no_onions', 'extra_cheese'] },
    { item_id: 'milkshake', quantity: 1, modifiers: ['flavor_chocolate', 'no_whip'] },
  ],
  remove_item: [{ item_id: 'fries' }, { item_id: 'coke' }],
  update_quantity: [{ item_id: 'burger', quantity: 3 }, { item_id: 'fries', quantity: 20 }],
  apply_modifier: [{ item_id: 'burger', modifier: 'no_pickles' }, { item_id: 'fries', modifier: 'no_salt' }],
  confirm_order: [{ order_id: 'o1', pickup_time: 'ASAP' }, { order_id: 'o1', pickup_time: ISO }],
  get_order_state: [{ order_id: 'o1' }, { order_id: 'abc' }],
};

const INVALID: Record<string, unknown[]> = {
  add_item: [
    { item_id: 'pizza', quantity: 1, modifiers: [] }, // unknown item
    { item_id: 'burger', quantity: 0, modifiers: [] }, // qty 0
    { item_id: 'burger', quantity: 1, modifiers: ['flavor_vanilla'] }, // modifier not valid for item
    { item_id: 'burger', quantity: 1.5, modifiers: [] },
    { item_id: 'milkshake', quantity: 1, modifiers: [] }, // flavor required
    { item_id: 'burger', quantity: 1, modifiers: [], extra: true }, // strict
  ],
  remove_item: [{ item_id: 'sushi' }, {}, { item_id: 'burger', quantity: 1 }],
  update_quantity: [{ item_id: 'burger', quantity: 0 }, { item_id: 'burger', quantity: 21 }, { item_id: 'burger', quantity: '3' }],
  apply_modifier: [{ item_id: 'fries', modifier: 'extra_cheese' }, { item_id: 'burger', modifier: 'bogus' }, { item_id: 'burger' }],
  confirm_order: [{ order_id: 'o1', pickup_time: 'soon' }, { order_id: 'o1' }, { pickup_time: 'ASAP' }],
  get_order_state: [{}, { order_id: '' }, { order_id: 'x', extra: 1 }],
};

describe('tool argument schemas (all six tools)', () => {
  for (const tool of TOOL_NAMES) {
    it(`${tool}: ≥2 valid payloads validate`, () => {
      expect(VALID[tool]!.length).toBeGreaterThanOrEqual(2);
      for (const p of VALID[tool]!) expect(validateToolArgs(tool, p), JSON.stringify(p)).toMatchObject({ ok: true });
    });
    it(`${tool}: ≥3 invalid payloads are rejected`, () => {
      expect(INVALID[tool]!.length).toBeGreaterThanOrEqual(3);
      for (const p of INVALID[tool]!) expect(validateToolArgs(tool, p).ok, JSON.stringify(p)).toBe(false);
    });
  }
  it('unknown tool is rejected', () => {
    expect(validateToolArgs('drop_table', {}).ok).toBe(false);
  });
});

describe('execution modes and declarations (D-01)', () => {
  it('every mutating tool is hold; get_order_state is interactive', () => {
    for (const t of MUTATING_TOOLS) expect(executionMode(t)).toBe('hold');
    expect(executionMode('get_order_state')).toBe('interactive');
  });
  it('declares exactly the six tools, and hides order_id from the model', () => {
    const d = toolDeclarations();
    expect(d.map((x) => x.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const decl of d) {
      expect(JSON.stringify(decl.parameters)).not.toContain('order_id');
      expect(decl.type).toBe('function');
      expect(decl.timeout_seconds).toBeGreaterThanOrEqual(1);
      expect(decl.timeout_seconds).toBeLessThanOrEqual(300);
    }
  });
  it('declared item and modifier enums match the menu', () => {
    const add = toolDeclarations().find((t) => t.name === 'add_item')!;
    const props = add.parameters.properties as Record<string, any>;
    expect(props.item_id.enum).toEqual(MENU.map((m) => m.item_id));
    expect(props.modifiers.items.enum).toEqual(ALL_MODIFIERS);
  });
});

describe('menu vocabulary', () => {
  it('has 12 items with unique ids and positive integer prices', () => {
    expect(MENU).toHaveLength(12);
    expect(new Set(MENU.map((m) => m.item_id)).size).toBe(12);
    for (const m of MENU) expect(Number.isInteger(m.price_cents) && m.price_cents > 0).toBe(true);
  });
  it('modifier classes follow the no_/sub_ convention', () => {
    expect(modifierClass('no_onions')).toBe('removal');
    expect(modifierClass('sub_chicken_for_beef')).toBe('substitution');
    expect(modifierClass('extra_cheese')).toBe('modifier');
  });
  it('cheeseburger does not offer extra_cheese', () => {
    expect(isAllowedModifier('cheeseburger', 'extra_cheese')).toBe(false);
    expect(isAllowedModifier('burger', 'extra_cheese')).toBe(true);
  });
  it('every item has at least one alias', () => {
    for (const m of MENU) expect(getItem(m.item_id)!.aliases.length).toBeGreaterThan(0);
  });
});

describe('total math', () => {
  it('scenario A: 2 burgers + coke = 2047', () => {
    expect(computeTotalCents([{ item_id: 'burger', quantity: 2, modifiers: [] }, { item_id: 'coke', quantity: 1, modifiers: [] }])).toBe(2047);
  });
  it('scenario B: 3 burgers = 2697', () => {
    expect(computeTotalCents([{ item_id: 'burger', quantity: 3, modifiers: [] }])).toBe(2697);
  });
  it('modifier deltas: 2×(899+100 extra_cheese)+249 = 2247', () => {
    expect(computeTotalCents([{ item_id: 'burger', quantity: 2, modifiers: ['extra_cheese'] }, { item_id: 'coke', quantity: 1, modifiers: [] }])).toBe(2247);
  });
  it('zero-delta modifiers do not change price', () => {
    expect(computeTotalCents([{ item_id: 'burger', quantity: 1, modifiers: ['no_onions', 'no_pickles'] }])).toBe(899);
  });
});

describe('conflict taxonomy', () => {
  it('every conflict code has a fixture', () => {
    expect(new Set(CONFLICT_FIXTURES.map((f) => f.code))).toEqual(new Set(CONFLICT_CODES));
  });
  it('every conflict code has a non-empty repair template', () => {
    for (const f of CONFLICT_FIXTURES) expect(repairAsk(f.code, f.repair_ctx).length).toBeGreaterThan(5);
  });
  it('repair prompts never mention items other than the disputed one', () => {
    for (const f of CONFLICT_FIXTURES) {
      const ask = repairAsk(f.code, f.repair_ctx).toLowerCase();
      for (const m of MENU) {
        if (m.item_id === f.repair_ctx.item_id) continue;
        for (const a of m.aliases) {
          // 'burger' is a substring of other burger names; only flag whole-word mentions of foreign items
          if (f.repair_ctx.item_id && getItem(f.repair_ctx.item_id)!.name.toLowerCase().includes(a)) continue;
          // the item the customer actually said (evidenced_value) is the disputed item too
          if (f.repair_ctx.evidenced_value?.replace(/_/g, ' ').includes(a)) continue;
          expect(ask, `${f.code} mentions ${a}`).not.toMatch(new RegExp(`\\b${a}\\b`));
        }
      }
    }
  });
  it('QTY_MISMATCH repair matches the brief example', () => {
    expect(repairAsk('QTY_MISMATCH', { item_id: 'burger', evidenced_value: '3' })).toBe("Just to confirm, that's 3 classic burgers?");
  });
});

describe('event schema', () => {
  const base = { id: 'e1', session_id: 's1', t_ms: 10, wall_ms: 1, audio_offset_ms: 0 };
  it('accepts a derived barge-in with two source events', () => {
    expect(TallyEvent.safeParse({ ...base, kind: 'barge_in', derived: true, source_event_ids: ['a', 'b'] }).success).toBe(true);
  });
  it('rejects a non-derived barge-in and a barge-in without exactly two sources', () => {
    expect(TallyEvent.safeParse({ ...base, kind: 'barge_in', derived: false, source_event_ids: ['a', 'b'] }).success).toBe(false);
    expect(TallyEvent.safeParse({ ...base, kind: 'barge_in', derived: true, source_event_ids: ['a'] }).success).toBe(false);
  });
  it('transcript events carry no confidence field requirement (D-03)', () => {
    expect(TallyEvent.safeParse({ ...base, kind: 'transcript_user', text: 'two burgers' }).success).toBe(true);
  });
});
