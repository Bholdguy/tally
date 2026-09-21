// Gate verdict TABLE (Step 5): (evidence, order, tool call) -> verdict + code, asserting BUSINESS OUTCOMES:
// HOLD rows leave `orders` byte-identical; ALLOW rows change exactly what the customer said, with a paired audit row.
import { afterAll, describe, expect, it } from 'vitest';
import { computeTotalCents } from '@tally/contract';
import { initDatabase } from '@tally/db';
import { Store } from '../src/committer.js';
import { makeRig, type Rig } from './rig.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dbPath = join(mkdtempSync(join(tmpdir(), 'tally-table-')), 't.sqlite');
initDatabase(dbPath);
const shared = new Store(dbPath);
afterAll(() => shared.close());
let n = 0;

const add = (item_id: string, quantity: number, modifiers: string[] = []) => ({ tool: 'add_item', args: { item_id, quantity, modifiers } });
const upd = (item_id: string, quantity: number) => ({ tool: 'update_quantity', args: { item_id, quantity } });
const mod = (item_id: string, modifier: string) => ({ tool: 'apply_modifier', args: { item_id, modifier } });
const rem = (item_id: string) => ({ tool: 'remove_item', args: { item_id } });
const conf = (pickup_time: string) => ({ tool: 'confirm_order', args: { order_id: 'ignored-by-gate', pickup_time } });

interface Row {
  name: string;
  say: string[];                       // finalised independent-stream utterances, in order
  order?: { tool: string; args: Record<string, unknown> }[];  // pre-existing committed order
  call: { tool: string; args: unknown };
  expect: { verdict: 'ALLOW' | 'HOLD'; code?: string; noop?: boolean; projection?: string };
  conf?: number;                       // per-word confidence on the utterances
  setup?: (r: Rig) => void;
  lines?: { item_id: string; quantity: number }[]; // expected lines after ALLOW
}

const ROWS: Row[] = [
  // ---------- ALLOW: evidence supports the call ----------
  { name: '01 add 2 burgers', say: ['two burgers'], call: add('burger', 2), expect: { verdict: 'ALLOW' }, lines: [{ item_id: 'burger', quantity: 2 }] },
  { name: '02 add a coke', say: ['a coke'], call: add('coke', 1), expect: { verdict: 'ALLOW' }, lines: [{ item_id: 'coke', quantity: 1 }] },
  { name: '03 inline correction: add 3', say: ['two burgers, no wait, make it three'], call: add('burger', 3), expect: { verdict: 'ALLOW' }, lines: [{ item_id: 'burger', quantity: 3 }] },
  { name: '04 inline correction as the API delivered it', say: ['2 burgers. No, wait, make it 3.'], call: add('burger', 3), expect: { verdict: 'ALLOW' }, lines: [{ item_id: 'burger', quantity: 3 }] },
  { name: '05 fries no salt', say: ['fries no salt'], call: add('fries', 1, ['no_salt']), expect: { verdict: 'ALLOW' } },
  { name: '06 burger two modifiers', say: ['a burger no onions extra cheese'], call: add('burger', 1, ['extra_cheese', 'no_onions']), expect: { verdict: 'ALLOW' } },
  { name: '07 chocolate shake', say: ['a chocolate shake'], call: add('milkshake', 1, ['flavor_chocolate']), expect: { verdict: 'ALLOW' } },
  { name: '08 update 2 -> 3 after a spoken correction', say: ['two burgers', 'no wait, make it three'], order: [add('burger', 2)], call: upd('burger', 3), expect: { verdict: 'ALLOW' }, lines: [{ item_id: 'burger', quantity: 3 }] },
  { name: '09 update 3 -> 2', say: ['three burgers', 'actually two'], order: [add('burger', 3)], call: upd('burger', 2), expect: { verdict: 'ALLOW' }, lines: [{ item_id: 'burger', quantity: 2 }] },
  { name: '10 apply no_onions', say: ['a burger', 'no onions'], order: [add('burger', 1)], call: mod('burger', 'no_onions'), expect: { verdict: 'ALLOW' } },
  { name: '11 remove fries', say: ['fries', 'cancel the fries'], order: [add('fries', 1)], call: rem('fries'), expect: { verdict: 'ALLOW' }, lines: [] },
  { name: '12 confirm ASAP', say: ['a burger, pickup as soon as possible'], order: [add('burger', 1)], call: conf('ASAP'), expect: { verdict: 'ALLOW' } },
  { name: '13 confirm 18:30 (pm implied by ISO)', say: ['a burger, pick up at six thirty'], order: [add('burger', 1)], call: conf('2026-09-20T18:30:00-04:00'), expect: { verdict: 'ALLOW' } },
  { name: '14 confirm 06:30 also matches "six thirty" (meridiem unspoken)', say: ['a burger, pick up at six thirty'], order: [add('burger', 1)], call: conf('2026-09-20T06:30:00-04:00'), expect: { verdict: 'ALLOW' } },
  { name: '15 large coke', say: ['a large coke'], call: add('coke', 1, ['size_large']), expect: { verdict: 'ALLOW' } },
  { name: '16 second item from the same utterance', say: ['two burgers and a coke'], order: [add('burger', 2)], call: add('coke', 1), expect: { verdict: 'ALLOW' } },
  { name: '17 twenty burgers', say: ['twenty burgers'], call: add('burger', 20), expect: { verdict: 'ALLOW' } },
  { name: '18 bare "burger" is an implicit 1', say: ['burger'], call: add('burger', 1), expect: { verdict: 'ALLOW' } },
  { name: '19 correction pair "yes three" after a repair question', say: ['two burgers', 'yes three'], order: [add('burger', 2)], call: upd('burger', 3), expect: { verdict: 'ALLOW' } },
  { name: '20 diet coke is its own item', say: ['one diet coke'], call: add('diet_coke', 1), expect: { verdict: 'ALLOW' } },
  // ---------- NOOP: exact repeat of committed state (D-20) ----------
  { name: '21 duplicate add_item(coke) is a no-op ALLOW, nothing written', say: ['two burgers and a coke'], order: [add('burger', 2), add('coke', 1)], call: add('coke', 1), expect: { verdict: 'ALLOW', noop: true } },
  { name: '22 update to the current quantity is a no-op', say: ['three burgers'], order: [add('burger', 3)], call: upd('burger', 3), expect: { verdict: 'ALLOW', noop: true } },
  // ---------- HOLD: definite disagreement between claim and customer ----------
  { name: '23 THE SPIKE CASE: agent claims 2, customer corrected to 3', say: ['two burgers, no wait, make it three'], call: add('burger', 2), expect: { verdict: 'HOLD', code: 'QTY_MISMATCH' } },
  { name: '24 claims 2, customer said 3', say: ['3 burgers'], call: add('burger', 2), expect: { verdict: 'HOLD', code: 'QTY_MISMATCH' } },
  { name: '25 claims 3, customer said 2', say: ['2 burgers'], call: add('burger', 3), expect: { verdict: 'HOLD', code: 'QTY_MISMATCH' } },
  { name: '26 claims a burger, customer wants a veggie burger', say: ['a veggie burger'], call: add('burger', 1), expect: { verdict: 'HOLD', code: 'ITEM_MISMATCH' } },
  { name: '27 claims cheeseburger, customer said burger', say: ['two burgers'], call: add('cheeseburger', 2), expect: { verdict: 'HOLD', code: 'ITEM_MISMATCH' } },
  { name: '28 phantom add while the customer only asked for burgers already on the order', say: ['two burgers'], order: [add('burger', 2)], call: add('milkshake', 1, ['flavor_vanilla']), expect: { verdict: 'HOLD', code: 'UNSUPPORTED_CLAIM' } },
  { name: '29 unrequested modifier (the observed size_large hallucination)', say: ['a coke'], call: add('coke', 1, ['size_large']), expect: { verdict: 'HOLD', code: 'MODIFIER_MISMATCH' } },
  { name: '30 omits a requested removal', say: ['a burger no onions'], call: add('burger', 1), expect: { verdict: 'HOLD', code: 'REMOVAL_MISMATCH' } },
  { name: '31 unrequested extra cheese', say: ['a burger'], call: add('burger', 1, ['extra_cheese']), expect: { verdict: 'HOLD', code: 'MODIFIER_MISMATCH' } },
  { name: '32 unrequested substitution', say: ['a burger'], call: add('burger', 1, ['sub_chicken_for_beef']), expect: { verdict: 'HOLD', code: 'SUBSTITUTION_MISMATCH' } },
  { name: '33 wrong removal modifier', say: ['a burger no onions'], call: add('burger', 1, ['no_pickles']), expect: { verdict: 'HOLD', code: 'REMOVAL_MISMATCH' } },
  { name: '34 update to 2 but the customer said 3', say: ['three burgers', 'make it three'], order: [add('burger', 3)], call: upd('burger', 2), expect: { verdict: 'HOLD', code: 'QTY_MISMATCH' } },
  { name: '35 update an item the customer never mentioned again', say: ['a coke'], order: [add('burger', 2)], call: upd('burger', 3), expect: { verdict: 'HOLD', code: 'ITEM_MISMATCH' } },
  { name: '36 apply no_onions the customer did not ask for', say: ['a burger'], order: [add('burger', 1)], call: mod('burger', 'no_onions'), expect: { verdict: 'HOLD', code: 'REMOVAL_MISMATCH' } },
  { name: '37 apply extra_cheese when the customer said no onions', say: ['a burger no onions'], order: [add('burger', 1)], call: mod('burger', 'extra_cheese'), expect: { verdict: 'HOLD', code: 'MODIFIER_MISMATCH' } },
  { name: '38 modifier on an item never mentioned', say: ['a coke'], order: [add('burger', 1)], call: mod('burger', 'no_onions'), expect: { verdict: 'HOLD', code: 'UNSUPPORTED_CLAIM' } },
  { name: '39 remove without a cancel', say: ['fries'], order: [add('fries', 1)], call: rem('fries'), expect: { verdict: 'HOLD', code: 'REMOVAL_MISMATCH' } },
  { name: '40 remove an item never mentioned', say: ['a burger'], order: [add('fries', 1)], call: rem('fries'), expect: { verdict: 'HOLD', code: 'REMOVAL_MISMATCH' } },
  { name: '41 confirm ASAP but the customer gave a time', say: ['a burger, pick up at six thirty'], order: [add('burger', 1)], call: conf('ASAP'), expect: { verdict: 'HOLD', code: 'PICKUP_TIME_MISMATCH' } },
  { name: '42 confirm 18:45 but the customer said six thirty', say: ['a burger, pick up at six thirty'], order: [add('burger', 1)], call: conf('2026-09-20T18:45:00-04:00'), expect: { verdict: 'HOLD', code: 'PICKUP_TIME_MISMATCH' } },
  { name: '43 confirm with no pickup evidence', say: ['two burgers'], order: [add('burger', 2)], call: conf('ASAP'), expect: { verdict: 'HOLD', code: 'PICKUP_TIME_MISMATCH' } },
  { name: '44 confirm 07:30 but the customer said six thirty', say: ['a burger, pick up at six thirty'], order: [add('burger', 1)], call: conf('2026-09-20T07:30:00-04:00'), expect: { verdict: 'HOLD', code: 'PICKUP_TIME_MISMATCH' } },
  { name: '45 confirm 07:00 when the customer said 7 pm', say: ['a burger, ready at 7 pm'], order: [add('burger', 1)], call: conf('2026-09-20T07:00:00-04:00'), expect: { verdict: 'HOLD', code: 'PICKUP_TIME_MISMATCH' } },
  // ---------- HOLD: cannot validate (ambiguity, confidence, no evidence) ----------
  { name: '46 homophone "for burgers" is ambiguous even if it matches', say: ['for burgers'], call: add('burger', 4), expect: { verdict: 'HOLD', code: 'UNVALIDATABLE' } },
  { name: '47 homophone "to burgers"', say: ['to burgers'], call: add('burger', 2), expect: { verdict: 'HOLD', code: 'UNVALIDATABLE' } },
  { name: '48 low confidence on the quantity word', say: ['2 burgers.'], conf: 0.4, call: add('burger', 2), expect: { verdict: 'HOLD', code: 'UNVALIDATABLE' } },
  { name: '49 no finalised customer speech at all', say: [], call: add('burger', 2), expect: { verdict: 'HOLD', code: 'UNVALIDATABLE' } },
  // ---------- HOLD: contract violations ----------
  { name: '50 unknown item', say: ['a pizza'], call: add('pizza', 1), expect: { verdict: 'HOLD', code: 'UNKNOWN_ITEM' } },
  { name: '51 modifier not allowed for the item', say: ['fries with extra cheese'], call: { tool: 'apply_modifier', args: { item_id: 'fries', modifier: 'extra_cheese' } }, order: [add('fries', 1)], expect: { verdict: 'HOLD', code: 'BAD_MODIFIER' } },
  { name: '52 quantity 0', say: ['zero burgers'], call: add('burger', 0), expect: { verdict: 'HOLD', code: 'SCHEMA_INVALID' } },
  { name: '53 get_order_state is not a gated tool', say: ['two burgers'], call: { tool: 'get_order_state', args: {} }, expect: { verdict: 'HOLD', code: 'SCHEMA_INVALID', projection: 'not_gated' } },
  { name: '54 milkshake without a flavor', say: ['a milkshake'], call: add('milkshake', 1), expect: { verdict: 'HOLD', code: 'SCHEMA_INVALID' } },
  { name: '55 malformed pickup time', say: ['a burger, pickup asap'], order: [add('burger', 1)], call: conf('soon'), expect: { verdict: 'HOLD', code: 'SCHEMA_INVALID' } },
  { name: '56 extra property', say: ['two burgers'], call: { tool: 'add_item', args: { item_id: 'burger', quantity: 2, modifiers: [], gift: true } }, expect: { verdict: 'HOLD', code: 'SCHEMA_INVALID' } },
  { name: '57 null args', say: ['two burgers'], call: { tool: 'add_item', args: null }, expect: { verdict: 'HOLD', code: 'SCHEMA_INVALID' } },
  { name: '58 unknown tool', say: ['two burgers'], call: { tool: 'drop_tables', args: {} }, expect: { verdict: 'HOLD', code: 'SCHEMA_INVALID', projection: 'not_gated' } },
  // ---------- HOLD: agent misused the tools (evidence fine, projection refuses): no repair question ----------
  { name: '59 add_item on an item already on the order with a different quantity', say: ['three burgers'], order: [add('burger', 2)], call: add('burger', 3), expect: { verdict: 'HOLD', code: 'SCHEMA_INVALID', projection: 'ALREADY_IN_ORDER' } },
  { name: '60 update_quantity for an item not on the order', say: ['three burgers'], call: upd('burger', 3), expect: { verdict: 'HOLD', code: 'SCHEMA_INVALID', projection: 'NOT_IN_ORDER' } },
  { name: '61 remove an item not on the order', say: ['fries', 'cancel the fries'], call: rem('fries'), expect: { verdict: 'HOLD', code: 'SCHEMA_INVALID', projection: 'NOT_IN_ORDER' } },
  { name: '62 confirm an empty order', say: ['pickup as soon as possible'], call: conf('ASAP'), expect: { verdict: 'HOLD', code: 'SCHEMA_INVALID', projection: 'EMPTY_ORDER' } },
  { name: '63 mutate after the order is confirmed', say: ['a burger, pickup asap', 'and a coke'], order: [add('burger', 1), conf('ASAP')], call: add('coke', 1), expect: { verdict: 'HOLD', code: 'SCHEMA_INVALID', projection: 'ORDER_CLOSED' } },
  // ---------- HOLD: the evidence stream itself ----------
  { name: '64 independent stream is DOWN (evidence would have matched)', say: ['two burgers'], call: add('burger', 2), setup: (r) => r.down('socket closed'), expect: { verdict: 'HOLD', code: 'UNVALIDATABLE' } },
  { name: '65 independent stream never came up', say: ['two burgers'], call: add('burger', 2), setup: () => undefined, expect: { verdict: 'HOLD', code: 'UNVALIDATABLE' } },
];

function run(row: Row) {
  const rig = makeRig({ sharedStore: shared, sharedPath: dbPath, session: `t${++n}` });
  if (row.name.startsWith('65 ')) { /* stream intentionally never up */ } else rig.up();
  if (row.order) rig.seed(...row.order);
  row.say.forEach((s) => rig.final(s, { conf: row.conf }));
  row.setup?.(rig);
  return rig;
}

describe('gate verdict table (business outcomes)', () => {
  it('has at least 60 rows', () => expect(ROWS.length).toBeGreaterThanOrEqual(60));

  for (const row of ROWS) {
    it(row.name, async () => {
      const rig = run(row);
      const before = rig.hash();
      const auditBefore = rig.audit();
      const res = await rig.call(row.call.tool, row.call.args);

      expect(res.verdict, JSON.stringify(res)).toBe(row.expect.verdict);
      if (res.verdict === 'HOLD') {
        expect(res.code).toBe(row.expect.code);
        // BUSINESS OUTCOME: a held call changes nothing in the order
        expect(rig.hash()).toBe(before);
        // and is recorded, flagged, with provenance
        const rec = rig.toolCalls().at(-1)!;
        expect(['held', 'conflict']).toContain(rec.status);
        expect(rec.conflict_type).toBe(row.expect.code);
        if (row.expect.projection) { expect(res.projection_error).toBe(row.expect.projection); expect(res.repair).toBeUndefined(); }
        else expect(res.repair).toBeDefined(); // a targeted repair instruction accompanies evidence-based holds
      } else if (row.expect.noop) {
        expect(res.noop).toBe(true);
        expect(rig.hash()).toBe(before);           // nothing written
        expect(rig.audit()).toBe(auditBefore);
      } else {
        expect(rig.hash()).not.toBe(before);
        expect(rig.audit()).toBe(auditBefore + 1);  // exactly one paired audit row
        const order = rig.store.getOrder(rig.session)!;
        expect(order.total_cents).toBe(computeTotalCents(order.state.lines));
        if (row.lines) expect(order.state.lines.map((l) => ({ item_id: l.item_id, quantity: l.quantity }))).toEqual(row.lines);
      }
      rig.close();
    });
  }

  it('a definite disagreement is recorded as conflict; a cannot-validate is recorded as held', async () => {
    const a = run({ name: 'x', say: ['3 burgers'], call: add('burger', 2), expect: { verdict: 'HOLD', code: 'QTY_MISMATCH' } });
    await a.call('add_item', { item_id: 'burger', quantity: 2, modifiers: [] });
    expect(a.toolCalls().at(-1)!.status).toBe('conflict');
    const b = run({ name: 'y', say: [], call: add('burger', 2), expect: { verdict: 'HOLD', code: 'UNVALIDATABLE' } });
    await b.call('add_item', { item_id: 'burger', quantity: 2, modifiers: [] });
    expect(b.toolCalls().at(-1)!.status).toBe('held');
  });

  it('repair instruction is scoped to the disputed item and carries the evidenced value (scenario B wording)', async () => {
    const r = run({ name: 'z', say: ['two burgers, no wait, make it three'], call: add('burger', 2), expect: { verdict: 'HOLD', code: 'QTY_MISMATCH' } });
    const res = await r.call('add_item', { item_id: 'burger', quantity: 2, modifiers: [] });
    expect(res).toMatchObject({ verdict: 'HOLD', code: 'QTY_MISMATCH', repair: { item_id: 'burger', evidenced_value: '3', ask_text: "Just to confirm, that's 3 classic burgers?" } });
  });

  it('the same call id is never decided twice (idempotent replay returns the recorded verdict)', async () => {
    const r = run({ name: 'w', say: ['two burgers'], call: add('burger', 2), expect: { verdict: 'ALLOW' } });
    const first = await r.call('add_item', { item_id: 'burger', quantity: 2, modifiers: [] }, 'same-id');
    const auditAfter = r.audit();
    const again = await r.call('add_item', { item_id: 'burger', quantity: 2, modifiers: [] }, 'same-id');
    expect(first.verdict).toBe('ALLOW');
    expect(again.verdict).toBe('ALLOW');
    expect(r.audit()).toBe(auditAfter);
    const bad = run({ name: 'v', say: ['3 burgers'], call: add('burger', 2), expect: { verdict: 'HOLD' } });
    await bad.call('add_item', { item_id: 'burger', quantity: 2, modifiers: [] }, 'held-id');
    const held2 = await bad.call('add_item', { item_id: 'burger', quantity: 2, modifiers: [] }, 'held-id');
    expect(held2).toMatchObject({ verdict: 'HOLD', code: 'QTY_MISMATCH' });
  });

  it('a model-supplied order_id is discarded: confirm_order always targets THIS session\'s order', async () => {
    const r = run({ name: 'u', say: ['a burger, pickup as soon as possible'], order: [add('burger', 1)], call: conf('ASAP'), expect: { verdict: 'ALLOW' } });
    const res = await r.call('confirm_order', { order_id: 'someone-elses-order', pickup_time: 'ASAP' });
    expect(res.verdict).toBe('ALLOW');
    expect(r.store.getOrder(r.session)!.state.status).toBe('confirmed');
  });
});
