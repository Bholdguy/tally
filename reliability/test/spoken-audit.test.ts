// AUDIT (D-28): nothing a customer could hear may contain an internal identifier or a malformed phrase.
// Class of bug: a template literal that interpolates an internal field (item_id, modifier id, evidence string, sentinel value)
// straight into speech ("keep 1 on the classic burger", "extra_cheese", "pickup none", "french friess").
import { describe, expect, it } from 'vitest';
import { ALL_MODIFIERS, CONFLICT_CODES, MENU, describeLine, escalationText, itemName, quantityPhrase, modifierLabel, MODIFIER_LABELS, repairAsk, type ConflictCode } from '@tally/contract';
import { makeRig } from './rig.js';

const IDS = [...MENU.map((m) => m.item_id), ...ALL_MODIFIERS];
const BAD_PLURALS = /friess|sandwichs|ringss|classic burgerss|\bss\b/;

/** Returns a list of problems in a string meant to be spoken (empty = speakable). */
export function speakableProblems(text: string): string[] {
  const p: string[] = [];
  if (/_/.test(text)) p.push('contains an underscore (internal id)');
  // ids that are also plain words (burger, fries, coke, warm ...) are indistinguishable from speech; every id WITH an underscore is caught here
  for (const id of IDS.filter((x) => x.includes('_'))) if (text.includes(id)) p.push(`contains raw id "${id}"`);
  if (/undefined|null|NaN|\[object|\$\{|\bnone\b|\bplain\b|\bkeep \d/i.test(text)) p.push('contains a sentinel / template leak');
  if (BAD_PLURALS.test(text)) p.push('malformed plural');
  if (/ {2,}/.test(text)) p.push('double space');
  if (/[:,]\s*[?.]/.test(text)) p.push('dangling punctuation');
  if (!/^[A-Z]/.test(text)) p.push('does not start with a capital');
  if (!/[.?]$/.test(text)) p.push('does not end with . or ?');
  return p;
}

const codes = CONFLICT_CODES as readonly ConflictCode[];
const modPairs = ALL_MODIFIERS.slice(0, 6).flatMap((a, i) => ALL_MODIFIERS.slice(i + 1, 7).map((b) => `${a}, ${b}`));
const VALUES: (string | undefined)[] = [
  undefined, '1', '2', '3', '12', 'plain', 'not_on_order', '$26.97', '$0.00', 'removed', 'keep 1', 'keep 3', 'none', 'as soon as possible', '6:30', '12:05', '9:00',
  'foo_bar', '', ...ALL_MODIFIERS, ...modPairs, ...MENU.map((m) => m.name.toLowerCase()), ...MENU.map((m) => m.item_id),
];

describe('AUDIT 1: every repair template x every conflict code x every item x every evidence-value shape is speakable', () => {
  it('renders speakable text for the whole cross product (and never throws)', () => {
    let n = 0; const bad: string[] = [];
    for (const code of codes) for (const item of [undefined, ...MENU.map((m) => m.item_id)]) for (const v of VALUES) {
      const t = repairAsk(code, { item_id: item, evidenced_value: v });
      n++;
      const pr = speakableProblems(t);
      if (pr.length) bad.push(`${code} item=${item} value=${JSON.stringify(v)} -> "${t}": ${pr.join('; ')}`);
    }
    expect(n).toBe(codes.length * (MENU.length + 1) * VALUES.length);
    expect(bad.slice(0, 15)).toEqual([]);
  });

  it('escalation wording is speakable for every item and for whole-order disputes', () => {
    for (const item of [undefined, ...MENU.map((m) => m.item_id)]) expect(speakableProblems(escalationText({ item_id: item }))).toEqual([]);
  });
});

describe('AUDIT 2: the spoken vocabulary itself', () => {
  it('every modifier in the menu has a label; labels are plain words, unique, with no ids or underscores', () => {
    expect(Object.keys(MODIFIER_LABELS).sort()).toEqual([...ALL_MODIFIERS].sort());            // none missing, none stale
    const labels = ALL_MODIFIERS.map(modifierLabel);
    expect(new Set(labels).size).toBe(labels.length);
    for (const l of labels) { expect(l).toMatch(/^[a-z][a-z -]*[a-z]$/); expect(l).not.toContain('that option'); }
  });

  it('plurals are correct for every item at quantities 1, 2 and 3 (french fries, chicken sandwiches, onion rings ...)', () => {
    for (const m of MENU) for (const q of [1, 2, 3]) {
      const s = `${q} ${itemName(m.item_id, q)}`;
      expect(s).not.toMatch(BAD_PLURALS);
    }
    expect(itemName('fries', 2)).toBe('french fries');
    expect(itemName('chicken_sandwich', 2)).toBe('chicken sandwiches');
    expect(itemName('onion_rings', 3)).toBe('onion rings');
    expect(itemName('burger', 3)).toBe('classic burgers');
    expect(quantityPhrase('fries', 1)).toBe('1 order of french fries');            // was "1 french fries"
    expect(quantityPhrase('onion_rings', 2)).toBe('2 orders of onion rings');
    expect(repairAsk('QTY_MISMATCH', { item_id: 'fries', evidenced_value: '2' })).toBe("Just to confirm, that's 2 orders of french fries?");
  });

  it('describeLine is speakable for every item alone and with each of its own modifiers', () => {
    for (const m of MENU) {
      expect(speakableProblems(`Got ${describeLine({ item_id: m.item_id, quantity: 2, modifiers: [] })}.`)).toEqual([]);
      for (const mod of m.modifiers) expect(speakableProblems(`Got ${describeLine({ item_id: m.item_id, quantity: 1, modifiers: [mod] })}.`)).toEqual([]);
    }
    expect(describeLine({ item_id: 'burger', quantity: 2, modifiers: ['no_onions', 'extra_cheese'] })).toBe('2 classic burgers with extra cheese and no onions');
  });
});

describe('AUDIT 3: the REAL evidence values the gate produces (not just synthetic ones) are speakable', () => {
  const asks: string[] = [];
  const spoken = (r: { verdict: string; repair?: { ask_text: string } }): string => { expect(r.verdict).toBe('HOLD'); asks.push(r.repair!.ask_text); return r.repair!.ask_text; };

  it('every (item, modifier) pair claimed but never requested, and every wrong quantity / wrong item / pickup disagreement', async () => {
    for (const m of MENU) {
      for (const mod of m.modifiers) {
        const r = makeRig(); r.up(); r.final(`I'd like a ${m.aliases[0]}.`);
        const res = await r.call('add_item', { item_id: m.item_id, quantity: 1, modifiers: [mod] });
        expect(speakableProblems(spoken(res as never)), `${m.item_id}+${mod}`).toEqual([]);
        r.close();
      }
      const r = makeRig(); r.up(); r.final(`I'd like three ${m.aliases[0]}.`);
      expect(speakableProblems(spoken(await r.call('add_item', { item_id: m.item_id, quantity: 2, modifiers: [] }) as never)), `qty ${m.item_id}`).toEqual([]);
      r.close();
    }
    expect(asks.length).toBeGreaterThan(70);
  });

  it('omitted modifiers of every class (removal, substitution, plain modifier), on the real judge', async () => {
    const cases: [string, string, string][] = [['burger', 'no onions', 'no_onions'], ['burger', 'extra cheese', 'extra_cheese'], ['burger', 'chicken instead of beef', 'sub_chicken_for_beef'], ['coke', 'a large', 'size_large'], ['milkshake', 'chocolate', 'flavor_chocolate']];
    for (const [item, say, mod] of cases) {
      const r = makeRig(); r.up(); r.final(`A ${item.replace('_', ' ')} with ${say}.`);
      const res = await r.call('add_item', { item_id: item, quantity: 1, modifiers: [] });
      if (res.verdict === 'HOLD') expect(speakableProblems(spoken(res as never)), `${item}/${mod}`).toEqual([]);
      r.close();
    }
  });

  it('pickup disagreements: no pickup said, as soon as possible, a clock time', async () => {
    const pk = async (evidence: string, arg: string): Promise<string> => {
      const r = makeRig(); r.up(); r.final(evidence); r.seed({ tool: 'add_item', args: { item_id: 'burger', quantity: 1, modifiers: [] } });
      const res = await r.call('confirm_order', { pickup_time: arg }); r.close(); return spoken(res as never);
    };
    expect(await pk('A burger.', 'ASAP')).toBe('What time would you like to pick up?');                       // was "pickup none?"
    expect(await pk('A burger, as soon as possible.', '2026-09-20T18:30:00-04:00')).toBe("Just to confirm, you'd like it as soon as possible?");
    expect(await pk('A burger. Pickup at six thirty.', 'ASAP')).toMatch(/^Just to confirm, pickup at 6:30\?$/);
  });
});
