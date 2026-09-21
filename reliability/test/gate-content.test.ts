// CONTENT-vs-INTENT coverage (Step 4 scope, owner request 2026-09-20): the gate must validate what a tool call CONTAINS,
// not just its quantity. The real hallucinations (spike-a.md §8) were an unrequested modifier list and an unrequested size,
// both with a correct quantity. These tests cover the whole CLASS systematically over the entire menu, not the two instances.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MENU, modifierClass } from '@tally/contract';
import { initDatabase } from '@tally/db';
import { Store } from '../src/committer.js';
import { extractEvidence } from '../src/extractor.js';
import { makeRig } from './rig.js';

const dbPath = join(mkdtempSync(join(tmpdir(), 'tally-content-')), 't.sqlite');
initDatabase(dbPath);
const shared = new Store(dbPath);
afterAll(() => shared.close());
let n = 0;

// How a customer would naturally say each modifier. ADJ = said before the item ("a large coke"); POST = after ("a burger, no onions").
const PHRASE: Record<string, { text: string; adj?: boolean }> = {
  no_onions: { text: 'no onions' }, no_pickles: { text: 'no pickles' }, no_tomato: { text: 'no tomato' }, no_lettuce: { text: 'no lettuce' },
  no_sauce: { text: 'no sauce' }, no_salt: { text: 'no salt' }, no_ice: { text: 'no ice' }, no_whip: { text: 'no whip' },
  extra_cheese: { text: 'extra cheese' }, extra_pickles: { text: 'extra pickles' }, extra_sauce: { text: 'extra sauce' }, extra_ice: { text: 'extra ice' },
  extra_crispy: { text: 'extra crispy', adj: true }, add_bacon: { text: 'add bacon' }, add_cheese: { text: 'add cheese' },
  gluten_free_bun: { text: 'gluten free', adj: true }, spicy: { text: 'spicy', adj: true }, warm: { text: 'warm', adj: true },
  size_large: { text: 'large', adj: true }, size_small: { text: 'small', adj: true },
  flavor_vanilla: { text: 'vanilla', adj: true }, flavor_chocolate: { text: 'chocolate', adj: true }, flavor_strawberry: { text: 'strawberry', adj: true },
  dressing_ranch: { text: 'ranch', adj: true }, dressing_vinaigrette: { text: 'vinaigrette', adj: true },
  sub_chicken_for_beef: { text: 'with chicken instead of beef' },
};
const alias = (id: string) => MENU.find((m) => m.item_id === id)!.aliases[0]!;
const say = (item: string, mod?: string, extra?: string) => {
  const p = mod ? PHRASE[mod]! : undefined;
  const base = p?.adj ? `a ${p.text} ${alias(item)}` : `a ${alias(item)}${p ? ' ' + p.text : ''}`;
  return extra ? `${base} ${extra}` : base;
};
const isFlavor = (m: string) => m.startsWith('flavor_');
/** schema: a milkshake needs exactly one flavor; supply the flavor the customer named (or vanilla for other modifiers) */
const callMods = (item: string, mods: string[], flavor = 'flavor_vanilla') => (item === 'milkshake' && !mods.some(isFlavor) ? [flavor, ...mods] : mods);

async function judge(say_: string[], tool: string, args: Record<string, unknown>) {
  const r = makeRig({ sharedStore: shared, sharedPath: dbPath, session: `c${++n}` });
  r.up(); say_.forEach((s) => r.final(s));
  const before = r.hash();
  const res = await r.call(tool, args);
  const unchanged = r.hash() === before;
  r.close();
  return { res, unchanged };
}

const PAIRS = MENU.flatMap((m) => m.modifiers.map((mod) => ({ item: m.item_id, mod })));

describe('content validation: every (item, modifier) pair in the menu', () => {
  it(`covers all ${PAIRS.length} pairs and every modifier has a spoken phrase`, () => {
    expect(PAIRS.length).toBeGreaterThan(55);
    for (const { mod } of PAIRS) expect(PHRASE[mod], mod).toBeDefined();
  });

  it('UNREQUESTED modifier (the real hallucination class): quantity right, modifier never said => HOLD with the right class of code, order untouched', async () => {
    const bad: string[] = [];
    for (const { item, mod } of PAIRS) {
      // a milkshake needs a flavor by schema; the customer named a different one, or (for a flavor mod) none of that flavor
      const said = item === 'milkshake' ? say(item, isFlavor(mod) ? 'flavor_chocolate' : 'flavor_vanilla') : say(item);
      const mods = item === 'milkshake' ? (isFlavor(mod) ? [mod] : ['flavor_vanilla' === mod ? 'flavor_chocolate' : 'flavor_vanilla', mod]) : [mod];
      if (item === 'milkshake' && isFlavor(mod) && mod === 'flavor_chocolate') continue; // that IS what was said
      const { res, unchanged } = await judge([said], 'add_item', { item_id: item, quantity: 1, modifiers: mods });
      const want = modifierClass(mod) === 'removal' ? 'REMOVAL_MISMATCH' : modifierClass(mod) === 'substitution' ? 'SUBSTITUTION_MISMATCH' : 'MODIFIER_MISMATCH';
      if (!(res.verdict === 'HOLD' && res.code === want && unchanged)) bad.push(`${item}+${mod} -> ${JSON.stringify(res.verdict === 'HOLD' ? res.code : res.verdict)} (wanted ${want})`);
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('REQUESTED modifier omitted from the call => HOLD (the customer\'s instruction would be lost)', async () => {
    const bad: string[] = [];
    for (const { item, mod } of PAIRS) {
      const said = item === 'milkshake' && !isFlavor(mod) ? `a vanilla milkshake ${PHRASE[mod]!.text}` : say(item, mod);
      // A milkshake needs exactly one flavor by schema. If the customer named a flavor, the call names a DIFFERENT one (their
      // instruction is lost); if they named another modifier, the call supplies only the flavor and omits that modifier.
      const otherFlavor = mod === 'flavor_vanilla' ? 'flavor_chocolate' : 'flavor_vanilla';
      const mods = item === 'milkshake' ? (isFlavor(mod) ? [otherFlavor] : ['flavor_vanilla']) : [];
      const { res, unchanged } = await judge([said], 'add_item', { item_id: item, quantity: 1, modifiers: mods });
      if (!(res.verdict === 'HOLD' && unchanged)) bad.push(`${item}+${mod} said "${said}" call ${JSON.stringify(mods)} -> ${res.verdict}`);
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('MATCHING call is ALLOWED for every pair the customer can say (extractor recall over the whole menu)', async () => {
    const misses: string[] = [];
    for (const { item, mod } of PAIRS) {
      const said = item === 'milkshake' && !isFlavor(mod) ? `a vanilla milkshake ${PHRASE[mod]!.text}` : say(item, mod);
      const mods = item === 'milkshake' && !isFlavor(mod) ? ['flavor_vanilla', mod] : [mod];
      const { res } = await judge([said], 'add_item', { item_id: item, quantity: 1, modifiers: mods });
      if (res.verdict !== 'ALLOW') misses.push(`${item}+${mod}: "${said}" -> ${res.verdict === 'HOLD' ? res.code + ' ' + res.detail : ''}`);
    }
    // An extractor miss holds a correct order (approved trade-off, D-22). We require full recall on the seeded vocabulary.
    expect(misses, misses.join('\n')).toEqual([]);
  });

  it('WRONG modifier of the same kind (said no onions, call says no pickles; said large, call says small) => HOLD', async () => {
    const swaps: [string, string, string][] = [['burger', 'no_onions', 'no_pickles'], ['burger', 'extra_cheese', 'add_bacon'], ['coke', 'size_large', 'size_small'], ['coke', 'no_ice', 'extra_ice'], ['fries', 'no_salt', 'extra_crispy'], ['milkshake', 'flavor_vanilla', 'flavor_chocolate'], ['side_salad', 'dressing_ranch', 'dressing_vinaigrette']];
    for (const [item, said, called] of swaps) {
      const { res, unchanged } = await judge([say(item, said)], 'add_item', { item_id: item, quantity: 1, modifiers: callMods(item, [called], called) });
      expect(res.verdict, `${item}: said ${said}, called ${called}`).toBe('HOLD');
      expect(unchanged).toBe(true);
    }
  });
});

describe('content validation: item identity and quantity across the whole menu', () => {
  it('a call for ANY other item than the one the customer named is held (all 132 ordered pairs)', async () => {
    const bad: string[] = [];
    for (const x of MENU) for (const y of MENU) {
      if (x.item_id === y.item_id) continue;
      const mods = y.item_id === 'milkshake' ? ['flavor_vanilla'] : [];
      const { res, unchanged } = await judge([`a ${x.aliases[0]}`], 'add_item', { item_id: y.item_id, quantity: 1, modifiers: mods });
      if (!(res.verdict === 'HOLD' && (res.code === 'ITEM_MISMATCH' || res.code === 'UNSUPPORTED_CLAIM') && unchanged)) bad.push(`said ${x.item_id}, called ${y.item_id} -> ${res.verdict === 'HOLD' ? res.code : 'ALLOW'}`);
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('every quantity 1..9: the matching quantity is allowed, every other quantity is held (81 cases)', async () => {
    const bad: string[] = [];
    for (let said = 1; said <= 9; said++) for (let called = 1; called <= 9; called++) {
      const { res } = await judge([`${said} burgers`], 'add_item', { item_id: 'burger', quantity: called, modifiers: [] });
      const ok = said === called ? res.verdict === 'ALLOW' : res.verdict === 'HOLD' && res.code === 'QTY_MISMATCH';
      if (!ok) bad.push(`said ${said}, called ${called} -> ${res.verdict}`);
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('several wrong dimensions at once (wrong qty AND hallucinated modifiers AND wrong item) are still held, never partially allowed', async () => {
    for (const args of [
      { item_id: 'burger', quantity: 5, modifiers: ['no_onions', 'no_pickles'] },
      { item_id: 'cheeseburger', quantity: 3, modifiers: ['extra_cheese'] },
      { item_id: 'burger', quantity: 3, modifiers: ['no_onions', 'no_pickles', 'no_tomato', 'no_lettuce', 'no_sauce'] }, // the real spike hallucination
    ]) {
      const { res, unchanged } = await judge(['2 burgers. No, wait, make it 3.'], 'add_item', args);
      expect(res.verdict, JSON.stringify(args)).toBe('HOLD');
      expect(unchanged).toBe(true);
    }
  });
});

describe('content validation: the other tools', () => {
  it('apply_modifier: every unrequested (item, modifier) is held; every requested one is allowed', async () => {
    const bad: string[] = [];
    for (const { item, mod } of PAIRS.filter((p) => p.item !== 'milkshake')) {
      const seed = { tool: 'add_item', args: { item_id: item, quantity: 1, modifiers: [] as string[] } };
      const run = async (said: string[]) => {
        const r = makeRig({ sharedStore: shared, sharedPath: dbPath, session: `a${++n}` });
        r.up(); r.seed(seed); said.forEach((s) => r.final(s));
        const before = r.hash();
        const res = await r.call('apply_modifier', { item_id: item, modifier: mod });
        const out = { res, unchanged: r.hash() === before };
        r.close();
        return out;
      };
      const un = await run([`a ${alias(item)}`]);
      if (!(un.res.verdict === 'HOLD' && un.unchanged)) bad.push(`unrequested ${item}+${mod} -> ${un.res.verdict}`);
      const ok = await run([`a ${alias(item)}`, PHRASE[mod]!.text]);
      if (ok.res.verdict !== 'ALLOW') bad.push(`requested ${item}+${mod} -> ${ok.res.verdict === 'HOLD' ? ok.res.code : ''}`);
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('remove_item: held unless the customer asked to cancel THAT item; update_quantity: held on any other number', async () => {
    for (const item of ['burger', 'fries', 'coke', 'milkshake', 'cookie']) {
      const seed = { tool: 'add_item', args: { item_id: item, quantity: 2, modifiers: item === 'milkshake' ? ['flavor_vanilla'] : [] } };
      const mk = (said: string[]) => { const r = makeRig({ sharedStore: shared, sharedPath: dbPath, session: `r${++n}` }); r.up(); r.seed(seed); said.forEach((s) => r.final(s)); return r; };
      const a = mk([`two ${alias(item)}s`]); const h = await a.call('remove_item', { item_id: item }); expect(h.verdict, `remove ${item} unrequested`).toBe('HOLD'); a.close();
      const b = mk([`two ${alias(item)}s`, `cancel the ${alias(item)}`]); const ok = await b.call('remove_item', { item_id: item }); expect(ok.verdict, `remove ${item} requested`).toBe('ALLOW'); b.close();
      const c = mk([`two ${alias(item)}s`, 'make it three']); const wrong = await c.call('update_quantity', { item_id: item, quantity: 2 }); expect(wrong.verdict, `update ${item}`).toBe('HOLD'); c.close();
    }
  });
});

describe('extractor PRECISION: phrases that merely look like modifiers must not become modifiers (a false modifier could let a hallucination through)', () => {
  const NOT_MODIFIERS = [
    '2 burgers. No, wait, make it 3.', 'a burger, no wait, two', 'no thanks', 'no, that is all', 'no more', 'nothing else', 'no problem', 'no worries',
    'a burger and a coke, that is all', 'a burger, actually two', 'a burger please', 'I would like a burger', 'can I get a burger and fries',
    'a burger, no', 'no no no two burgers', 'a big appetite today, a burger', 'a coke, and a large order of nothing else',
    'two burgers, no wait, three burgers', 'a burger and a coke, no wait, two cokes',
  ];
  it('no modifier evidence is produced by any of these ordinary phrases', () => {
    const bad: string[] = [];
    for (const s of NOT_MODIFIERS) {
      const e = extractEvidence([{ text: s }]);
      const mods = [...e.items.values()].flatMap((i) => [...i.modifiers]);
      // "a large order" is the one genuinely ambiguous phrase: it is allowed to read as size_large on a drink (fail closed), but never on food
      if (mods.length && !/large order/.test(s)) bad.push(`"${s}" -> ${mods.join(',')}`);
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });
  it('an adjective that fits no item in THIS utterance is dropped, not attached to an item from an earlier utterance', () => {
    const e = extractEvidence([{ text: 'a coke' }, { text: 'and a big burger' }]);
    expect(e.items.get('coke')!.modifiers.size).toBe(0);          // "big" must not silently become size_large on the earlier coke
    expect(e.items.get('burger')!.modifiers.size).toBe(0);
  });
  it('a modifier phrase with NO item in its utterance still attaches to the last-mentioned item that allows it ("no onions" as a follow-up)', () => {
    const e = extractEvidence([{ text: 'a burger' }, { text: 'no onions' }]);
    expect([...e.items.get('burger')!.modifiers]).toEqual(['no_onions']);
  });
});
