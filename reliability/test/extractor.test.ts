import { describe, expect, it } from 'vitest';
import { claimedItems, extractEvidence, type EvidenceUtterance } from '../src/extractor.js';

type Summary = Record<string, { q: number | null; mods: string[]; removed: boolean; implicit: boolean; ambiguous: boolean }>;
function ev(...utts: (string | EvidenceUtterance)[]): { items: Summary; pickup: unknown } {
  const s = extractEvidence(utts.map((u) => (typeof u === 'string' ? { text: u } : u)));
  const items: Summary = {};
  for (const [k, e] of s.items) items[k] = { q: e.quantity, mods: [...e.modifiers].sort(), removed: e.removed, implicit: e.quantityImplicit, ambiguous: e.quantityAmbiguous };
  return { items, pickup: s.pickup };
}
const q = (r: ReturnType<typeof ev>, item: string) => r.items[item]?.q ?? null;

describe('extractor golden set: quantities and item aliases', () => {
  it('1 digits', () => expect(q(ev('2 burgers.'), 'burger')).toBe(2));
  it('2 number words', () => expect(q(ev('Two burgers'), 'burger')).toBe(2));
  it('3 a/an means one', () => expect(q(ev('a coke'), 'coke')).toBe(1));
  it('4 multiple items', () => { const r = ev('two burgers and a coke'); expect([q(r, 'burger'), q(r, 'coke')]).toEqual([2, 1]); });
  it('5 plural aliases (fries, cookies, shakes)', () => { const r = ev('three cookies and two shakes'); expect([q(r, 'cookie'), q(r, 'milkshake')]).toEqual([3, 2]); });
  it('6 multiword alias (onion rings) is not confused with onions', () => expect(q(ev('one order of onion rings'), 'onion_rings')).toBe(1));
  it('7 veggie burger is its own item, not burger', () => { const r = ev('a veggie burger'); expect(r.items.veggie_burger?.q).toBe(1); expect(r.items.burger).toBeUndefined(); });
  it('8 cheeseburger vs burger', () => { const r = ev('two cheeseburgers'); expect(r.items.cheeseburger?.q).toBe(2); expect(r.items.burger).toBeUndefined(); });
  it('9 diet coke beats coke', () => { const r = ev('one diet coke'); expect(r.items.diet_coke?.q).toBe(1); expect(r.items.coke).toBeUndefined(); });
  it('10 chicken sandwich via alias "chicken"', () => expect(q(ev('a chicken sandwich'), 'chicken_sandwich')).toBe(1));
  it('11 bare mention is an implicit 1', () => { const r = ev('burger'); expect(r.items.burger).toMatchObject({ q: 1, implicit: true }); });
  it('12 twenty is supported, larger is not invented', () => expect(q(ev('twenty burgers'), 'burger')).toBe(20));
  it('13 nothing on the menu ⇒ no evidence', () => expect(ev('a pizza please').items).toEqual({}));
  it('14 empty and punctuation-only input ⇒ no evidence', () => { expect(ev('').items).toEqual({}); expect(ev('...!?').items).toEqual({}); });
});

describe('extractor golden set: corrections (last mention wins)', () => {
  it('15 inline correction with cue', () => expect(q(ev('two burgers, no wait, make it three'), 'burger')).toBe(3));
  it('16 inline correction as one final transcript with punctuation', () => expect(q(ev('2 burgers. No, wait, make it 3.'), 'burger')).toBe(3));
  it('17 correction in a later utterance', () => expect(q(ev('2 burgers.', 'No, wait, make it 3.'), 'burger')).toBe(3));
  it('18 correction with explicit item', () => expect(q(ev('two burgers', 'actually make it three burgers'), 'burger')).toBe(3));
  it('19 correction changes only the last-mentioned item', () => { const r = ev('two burgers and a coke', 'no wait, make it two'); expect([q(r, 'burger'), q(r, 'coke')]).toEqual([2, 2]); });
  it('20 "I mean" cue', () => expect(q(ev('two burgers, I mean three'), 'burger')).toBe(3));
  it('21 bare confirmation number after a repair question ("yes three")', () => expect(q(ev('two burgers', 'yes three'), 'burger')).toBe(3));
  it('22 correction to a smaller number', () => expect(q(ev('five burgers, no wait, two'), 'burger')).toBe(2));
  it('23 a later explicit mention beats an earlier one without a cue', () => expect(q(ev('two burgers', 'three burgers'), 'burger')).toBe(3));
  it('24 correction counted as a cue', () => expect(extractEvidence([{ text: 'two burgers no wait three' }]).cueCount).toBe(1));
  it('25 no cue and no item: a stray number does not silently change the order', () => expect(q(ev('two burgers', 'my number is 5 5 5'), 'burger')).toBe(2));
});

describe('extractor golden set: homophones and ambiguity are flagged, not resolved silently', () => {
  it('26 "for burgers" reads as 4 but is flagged ambiguous', () => expect(ev('for burgers').items.burger).toMatchObject({ q: 4, ambiguous: true }));
  it('27 "to burgers" reads as 2 but is flagged ambiguous', () => expect(ev('to burgers').items.burger).toMatchObject({ q: 2, ambiguous: true }));
  it('28 an unambiguous number clears the flag', () => expect(ev('for burgers', 'no wait, two burgers').items.burger).toMatchObject({ q: 2, ambiguous: false }));
  it('29 a preposition "for" not adjacent to an item is not a quantity', () => expect(ev('fries for me').items.fries).toMatchObject({ q: 1, implicit: true }));
});

describe('extractor golden set: modifiers, removals, substitutions', () => {
  it('30 no onions', () => expect(ev('a burger with no onions').items.burger!.mods).toEqual(['no_onions']));
  it('31 several modifiers on one item', () => expect(ev('a burger, no onions, extra cheese').items.burger!.mods).toEqual(['extra_cheese', 'no_onions']));
  it('32 "without pickles" / "hold the pickles"', () => { expect(ev('burger without pickles').items.burger!.mods).toEqual(['no_pickles']); expect(ev('burger hold the pickles').items.burger!.mods).toEqual(['no_pickles']); });
  it('33 modifier attaches to the nearest allowed item ("no salt" -> fries, not burger)', () => expect(ev('a burger and fries no salt').items.fries!.mods).toEqual(['no_salt']));
  it('34 modifier not allowed for the nearest item falls back to an earlier allowed one', () => { const r = ev('a burger and a coke, no onions'); expect(r.items.burger!.mods).toEqual(['no_onions']); expect(r.items.coke!.mods).toEqual([]); });
  it('35 size before the item ("large coke")', () => expect(ev('a large coke').items.coke!.mods).toEqual(['size_large']));
  it('36 exclusive groups: last size wins', () => expect(ev('a large coke', 'no wait, small coke').items.coke!.mods).toEqual(['size_small']));
  it('37 milkshake flavor', () => expect(ev('a chocolate shake').items.milkshake!.mods).toEqual(['flavor_chocolate']));
  it('38 substitution phrase', () => expect(ev('a burger with chicken instead of beef').items.burger!.mods).toEqual(['sub_chicken_for_beef']));
  it('39 "chicken" in a substitution is NOT a chicken sandwich order (no false item evidence)', () => { const r = ev('a burger with chicken instead of beef'); expect(r.items.chicken_sandwich).toBeUndefined(); expect(r.items.burger!.mods).toEqual(['sub_chicken_for_beef']); });
  it('39b every substitution phrasing masks the word chicken, but a real chicken sandwich order still counts', () => {
    for (const s of ['a burger, chicken instead of beef', 'a burger sub chicken', 'a burger substitute chicken for the beef', 'swap the beef for chicken on a burger']) expect(ev(s).items.chicken_sandwich, s).toBeUndefined();
    expect(ev('a burger and a chicken sandwich').items.chicken_sandwich?.q).toBe(1);
  });
  it('40 cancel removes an item', () => expect(ev('two burgers and fries', 'cancel the fries').items.fries!.removed).toBe(true));
  it('41 "no fries" as an item removal, but "no wait" is not', () => { expect(ev('burger and fries', 'no fries').items.fries!.removed).toBe(true); expect(ev('two burgers, no wait, three').items.burger!.removed).toBe(false); });
  it('42 re-adding after removal clears it', () => expect(ev('fries', 'cancel the fries', 'actually two fries').items.fries).toMatchObject({ q: 2, removed: false }));
  it('43 modifier the menu does not allow is dropped (extra cheese on fries)', () => expect(ev('fries with extra cheese').items.fries!.mods).toEqual([]));
  it('44 add cheese on fries is allowed', () => expect(ev('fries add cheese').items.fries!.mods).toEqual(['add_cheese']));
  it('45 gluten free bun', () => expect(ev('a gluten free burger').items.burger!.mods).toEqual(['gluten_free_bun']));
});

describe('extractor golden set: pickup time', () => {
  it('46 ASAP', () => expect(ev('a burger, pickup as soon as possible').pickup).toEqual({ kind: 'asap' }));
  it('47 clock time from words', () => expect(ev('pick up at six thirty').pickup).toEqual({ kind: 'time', hour: 6, minute: 30, meridiem: null }));
  it('48 clock time with meridiem', () => expect(ev('ready at 7 pm').pickup).toEqual({ kind: 'time', hour: 7, minute: 0, meridiem: 'pm' }));
  it('49 no pickup evidence', () => expect(ev('two burgers').pickup).toBeNull());
});

describe('extractor: per-word confidence is carried to the quantity/item that used it', () => {
  const words = (pairs: [string, number][]) => pairs.map(([text, confidence]) => ({ text, confidence }));
  it('50 min confidence over item + quantity tokens', () => {
    const r = extractEvidence([{ text: '3 burgers.', words: words([['3', 0.55], ['burgers.', 0.95]]) }]);
    expect(r.items.get('burger')!.minConf).toBe(0.55);
  });
  it('51 a confident correction replaces the low-confidence earlier reading', () => {
    const r = extractEvidence([{ text: '2 burgers.', words: words([['2', 0.4], ['burgers.', 0.9]]) }, { text: 'No, wait, make it 3.', words: words([['No,', 0.9], ['wait,', 0.9], ['make', 0.9], ['it', 0.9], ['3.', 0.92]]) }]);
    expect(r.items.get('burger')).toMatchObject({ quantity: 3, minConf: 0.92 });
  });
  it('52 words that do not line up with the text give unknown (null) confidence, never a made-up one', () => {
    const r = extractEvidence([{ text: '2 burgers.', words: words([['totally', 0.9], ['different', 0.9]]) }]);
    expect(r.items.get('burger')!.minConf).toBeNull();
  });
});

describe('claimedItems (used by the spoken-drift check)', () => {
  it('reads the quantity the AGENT stated', () => expect(claimedItems('Okay, two burgers. Anything else for you?')).toEqual([{ item_id: 'burger', quantity: 2, explicit: true }]));
  it('a bare mention in a question is not an explicit quantity', () => expect(claimedItems('Would you like fries with that?')).toEqual([{ item_id: 'fries', quantity: 1, explicit: false }]));
});

describe('determinism', () => {
  it('same input twice gives identical evidence', () => {
    const a = JSON.stringify(ev('two burgers, no wait, three', 'a coke no ice'));
    const b = JSON.stringify(ev('two burgers, no wait, three', 'a coke no ice'));
    expect(a).toBe(b);
  });
});
