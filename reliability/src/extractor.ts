// Deterministic evidence extractor (DECISIONS D-14, rule 3). Rule-based only: no LLM. It turns what the CUSTOMER said
// (finalised or partial transcripts from Tally's independent STT stream) into an "evidenced order intent" per item.
// Ambiguity is flagged, never resolved silently. Per-token confidence (independent stream) is carried through so the
// gate can hold on low-confidence quantity/item words.
import { ALL_MODIFIERS, FLAVORS, MENU, isAllowedModifier } from '@tally/contract';

export interface EvidenceWord { text: string; confidence: number }
export interface EvidenceUtterance { text: string; words?: readonly EvidenceWord[] }

export interface ItemEvidence {
  item_id: string;
  quantity: number | null;          // last-mention-wins
  quantityImplicit: boolean;        // no number was spoken ("a burger", bare "burger")
  quantityAmbiguous: boolean;       // homophone reading (to/too/for) used as the quantity
  modifiers: Set<string>;
  removed: boolean;
  minConf: number | null;           // min confidence over the tokens that produced the CURRENT quantity/item (null = unknown)
  lastMention: number;              // monotonically increasing mention index
}
export type PickupEvidence = { kind: 'asap' } | { kind: 'time'; hour: number; minute: number; meridiem: 'am' | 'pm' | null };
export interface EvidenceState {
  items: Map<string, ItemEvidence>;
  pickup: PickupEvidence | null;
  cueCount: number;
  seq: number;                      // ordering counter for mentions (kept in the state so extraction is a pure function)
}

const NUMS: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };
const HOMOPHONE_NUMS: Record<string, number> = { to: 2, too: 2, for: 4, won: 1 };
const ARTICLES = new Set(['a', 'an']);
const CUES = [['no', 'wait'], ['wait'], ['actually'], ['make', 'it'], ['make', 'that'], ['scratch', 'that'], ['i', 'mean'], ['instead'], ['sorry'], ['change', 'it'], ['change', 'that']];
const REMOVE_VERBS = new Set(['cancel', 'remove', 'drop', 'forget', 'delete']);
const FILLERS = new Set(['the', 'my', 'that', 'those', 'these', 'this', 'of', 'all']);
const BARE_OK = new Set(['yes', 'yeah', 'yep', 'yup', 'ok', 'okay', 'please', 'thanks', 'thank', 'you', 'right', 'correct', 'sure', 'that', 'thats', 'is', 'make', 'it', 'just']);
const EXCLUSIVE: string[][] = [[...FLAVORS], ['size_large', 'size_small'], ['no_ice', 'extra_ice']];

// alias table (longest first); plural handled by singularisation
const ALIASES: { tokens: string[]; item_id: string }[] = MENU.flatMap((m) => m.aliases.map((a) => ({ tokens: a.toLowerCase().split(' '), item_id: m.item_id })))
  .sort((a, b) => b.tokens.length - a.tokens.length);

function singular(t: string): string[] {
  const out = [t];
  if (t.endsWith('ies')) out.push(t.slice(0, -1)); // cookies -> cookie
  if (t.endsWith('es')) out.push(t.slice(0, -2));  // sandwiches -> sandwich
  if (t.endsWith('s')) out.push(t.slice(0, -1));   // burgers -> burger
  return out;
}

interface Tok { t: string; conf: number | null; boundary?: boolean; masked?: boolean }

function tokenise(u: EvidenceUtterance): Tok[] {
  const norm = (s: string) => s.toLowerCase().replace(/[—–-]/g, ' ').replace(/'/g, '');
  const pieces = (s: string): { t: string; boundary: boolean }[] => {
    const res: { t: string; boundary: boolean }[] = [];
    const cleaned = norm(s);
    const re = /([a-z0-9$]+(?::\d\d)?)|([.,;!?:])/g;
    for (const m of cleaned.matchAll(re)) {
      if (m[1]) res.push({ t: m[1], boundary: false });
      else res.push({ t: '|', boundary: true });
    }
    return res;
  };
  const textToks = pieces(u.text);
  // carry per-word confidence when the words[] segmentation lines up with the text tokenisation
  let confs: (number | null)[] | null = null;
  if (u.words && u.words.length) {
    const flat: { t: string; conf: number }[] = [];
    for (const w of u.words) for (const p of pieces(w.text)) if (!p.boundary) flat.push({ t: p.t, conf: w.confidence });
    const textWords = textToks.filter((p) => !p.boundary).map((p) => p.t);
    if (flat.length === textWords.length && flat.every((f, i) => f.t === textWords[i])) confs = flat.map((f) => f.conf);
  }
  let wi = 0;
  return textToks.map((p) => (p.boundary ? { t: '|', conf: null, boundary: true } : { t: p.t, conf: confs ? confs[wi++]! : null }));
}

const minConf = (...c: (number | null)[]): number | null => {
  const known = c.filter((x): x is number => x !== null);
  return known.length ? Math.min(...known) : null;
};

function numberAt(toks: Tok[], i: number): { value: number; ambiguous: boolean; conf: number | null } | null {
  const t = toks[i]?.t;
  if (t === undefined || toks[i]!.boundary) return null;
  if (/^\d{1,2}$/.test(t)) return { value: Number(t), ambiguous: false, conf: toks[i]!.conf };
  if (t in NUMS) return { value: NUMS[t]!, ambiguous: false, conf: toks[i]!.conf };
  if (ARTICLES.has(t)) return { value: 1, ambiguous: false, conf: toks[i]!.conf };
  if (t in HOMOPHONE_NUMS) return { value: HOMOPHONE_NUMS[t]!, ambiguous: true, conf: toks[i]!.conf };
  return null;
}

/**
 * Words that belong to a MODIFIER phrase must not count as item mentions: in "a burger with chicken instead of beef" the word
 * "chicken" is a substitution, not an order for a chicken sandwich. Reading it as an item would create false evidence and
 * could let a hallucinated add_item(chicken_sandwich) through.
 */
function maskSubstitutionWords(toks: Tok[]): void {
  const words = toks.map((x, i) => ({ x, i })).filter((w) => !w.x.boundary);
  const at = (k: number) => words[k]?.x.t;
  for (let k = 0; k < words.length; k++) {
    const isBeef = (j: number) => at(j) === 'beef' || at(j) === 'patty';
    // "chicken instead of (the) beef|patty", "chicken patty instead"
    if (at(k) === 'chicken' && (at(k + 1) === 'instead' || (at(k + 1) === 'patty' && at(k + 2) === 'instead'))) words[k]!.x.masked = true;
    // "sub|substitute chicken (for (the) beef|patty)"
    if ((at(k) === 'sub' || at(k) === 'substitute') && at(k + 1) === 'chicken') words[k + 1]!.x.masked = true;
    // "swap (the) beef|patty for chicken"
    if (at(k) === 'swap') { for (let j = k + 1; j < Math.min(words.length, k + 6); j++) if (at(j) === 'chicken') words[j]!.x.masked = true; }
    if (isBeef(k) && at(k + 1) === 'for' && at(k + 2) === 'chicken') words[k + 2]!.x.masked = true;
  }
}

function matchAlias(toks: Tok[], i: number): { item_id: string; len: number; conf: number | null } | null {
  if (toks[i]?.masked) return null;
  for (const a of ALIASES) {
    const n = a.tokens.length;
    if (i + n > toks.length) continue;
    let ok = true;
    const confs: (number | null)[] = [];
    for (let k = 0; k < n; k++) {
      const tk = toks[i + k]!;
      if (tk.boundary) { ok = false; break; }
      const want = a.tokens[k]!;
      const isLast = k === n - 1;
      if (!(tk.t === want || (isLast && singular(tk.t).includes(want)))) { ok = false; break; }
      confs.push(tk.conf);
    }
    if (ok) return { item_id: a.item_id, len: n, conf: minConf(...confs) };
  }
  return null;
}

/** Index (in toks) of the first token of the first correction-cue phrase, or -1. */
function cuePosition(toks: Tok[]): number {
  const idx = toks.map((x, i) => (x.boundary ? -1 : i)).filter((i) => i >= 0);
  for (let a = 0; a < idx.length; a++) {
    for (const c of CUES) {
      if (c.every((w, k) => toks[idx[a + k] ?? -1]?.t === w)) return idx[a]!;
    }
  }
  return -1;
}

function hasCue(toks: Tok[]): boolean {
  const words = toks.filter((x) => !x.boundary).map((x) => x.t);
  return CUES.some((c) => words.some((_, i) => c.every((w, k) => words[i + k] === w)));
}

const MOD_PHRASES: { id: string; re: RegExp }[] = [
  { id: 'sub_chicken_for_beef', re: /\b(chicken instead of (the )?(beef|patty)|sub(stitute)? chicken( for (the )?(beef|patty))?|swap (the )?(beef|patty) for chicken|chicken patty instead)\b/ },
  { id: 'no_onions', re: /\b(no|without|hold( the)?) onions?\b/ },
  { id: 'no_pickles', re: /\b(no|without|hold( the)?) pickles?\b/ },
  { id: 'no_tomato', re: /\b(no|without|hold( the)?) tomato(es)?\b/ },
  { id: 'no_lettuce', re: /\b(no|without|hold( the)?) lettuce\b/ },
  { id: 'no_sauce', re: /\b(no|without|hold( the)?) sauce\b/ },
  { id: 'no_salt', re: /\b(no|without|hold( the)?) salt\b/ },
  { id: 'no_ice', re: /\b(no|without|hold( the)?) ice\b/ },
  { id: 'no_whip', re: /\b(no|without|hold( the)?) whip(ped cream)?\b/ },
  { id: 'extra_cheese', re: /\bextra cheese\b/ },
  { id: 'add_cheese', re: /\b(add|with) cheese\b/ },
  { id: 'extra_pickles', re: /\bextra pickles?\b/ },
  { id: 'extra_sauce', re: /\bextra sauce\b/ },
  { id: 'extra_ice', re: /\bextra ice\b/ },
  { id: 'extra_crispy', re: /\b(extra )?crispy\b/ },
  { id: 'add_bacon', re: /\b(add |with |extra )?bacon\b/ },
  { id: 'gluten_free_bun', re: /\bgluten free( bun)?\b/ },
  { id: 'spicy', re: /\bspicy\b/ },
  { id: 'warm', re: /\bwarm(ed)?\b/ },
  { id: 'size_large', re: /\b(large|big)\b/ },
  { id: 'size_small', re: /\bsmall\b/ },
  { id: 'flavor_vanilla', re: /\bvanilla\b/ },
  { id: 'flavor_chocolate', re: /\bchocolate\b/ },
  { id: 'flavor_strawberry', re: /\bstrawberry\b/ },
  { id: 'dressing_ranch', re: /\branch\b/ },
  { id: 'dressing_vinaigrette', re: /\bvinaigrette\b/ },
];
const KNOWN_MODS = new Set(ALL_MODIFIERS);

interface Mention { item_id: string; start: number; end: number; qIdx: number | null; qty: number | null; implicit: boolean; ambiguous: boolean; conf: number | null; removal: boolean }

const TENS: Record<string, number> = { thirty: 30, forty: 40, fifty: 50 };
/** "six thirty" -> "6 30", "seven forty five" -> "7 45". Used for pickup times only. */
function digitiseNumberWords(words: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w in TENS) {
      const next = words[i + 1];
      if (next !== undefined && next in NUMS && NUMS[next]! >= 1 && NUMS[next]! <= 9) { out.push(String(TENS[w]! + NUMS[next]!)); i++; continue; }
      out.push(String(TENS[w]));
    } else if (w in NUMS) out.push(String(NUMS[w]));
    else out.push(w);
  }
  return out;
}

export function newEvidenceState(): EvidenceState {
  return { items: new Map(), pickup: null, cueCount: 0, seq: 0 };
}

function ensure(state: EvidenceState, item_id: string, idx: number): ItemEvidence {
  let e = state.items.get(item_id);
  if (!e) {
    e = { item_id, quantity: null, quantityImplicit: false, quantityAmbiguous: false, modifiers: new Set(), removed: false, minConf: null, lastMention: idx };
    state.items.set(item_id, e);
  }
  return e;
}

/** Fold ONE utterance into the cumulative evidence state (last-mention-wins). Mutates and returns `state`. */
export function foldUtterance(state: EvidenceState, u: EvidenceUtterance): EvidenceState {
  const toks = tokenise(u);
  maskSubstitutionWords(toks);
  const cue = hasCue(toks);
  if (cue) state.cueCount++;

  // ---- 1. item mentions (with quantity and removal scope) ----
  const mentions: Mention[] = [];
  for (let i = 0; i < toks.length; i++) {
    if (toks[i]!.boundary) continue;
    const m = matchAlias(toks, i);
    if (!m) continue;
    // quantity: nearest number/article within 3 tokens before the alias, not crossing a clause boundary
    let qty: number | null = null; let ambiguous = false; let qconf: number | null = null; let qIdx: number | null = null;
    for (let k = i - 1; k >= Math.max(0, i - 3); k--) {
      if (toks[k]!.boundary) break;
      const n = numberAt(toks, k);
      if (n) { qty = n.value; ambiguous = n.ambiguous; qconf = n.conf; qIdx = k; break; }
    }
    // removal: "cancel the fries", "no fries", "without the fries"
    let removal = false;
    let k = i - 1;
    while (k >= 0 && !toks[k]!.boundary && FILLERS.has(toks[k]!.t)) k--;
    if (k >= 0 && !toks[k]!.boundary) {
      const w = toks[k]!.t;
      const before = k > 0 && !toks[k - 1]!.boundary ? toks[k - 1]!.t : '';
      if (REMOVE_VERBS.has(w) || w === 'without' || (w === 'no' && before !== 'wait' && qty === null)) removal = true;
      if (w === 'scratch' && qty === null) removal = true;
    }
    mentions.push({ item_id: m.item_id, start: i, end: i + m.len, qIdx, qty, implicit: qty === null && !removal, ambiguous, conf: minConf(m.conf, qconf), removal });
    i += m.len - 1;
  }

  // ---- 2. apply mentions ----
  const idxBase = ++state.seq;
  mentions.forEach((m, n) => {
    const e = ensure(state, m.item_id, idxBase * 1000 + n);
    e.lastMention = idxBase * 1000 + n;
    if (m.removal) { e.removed = true; e.minConf = m.conf; return; }
    e.removed = false;
    // a quantity stated explicitly replaces; a bare mention only sets an implicit 1 if nothing is known yet
    if (m.qty !== null) { e.quantity = m.qty; e.quantityImplicit = false; e.quantityAmbiguous = m.ambiguous; e.minConf = m.conf; }
    else if (e.quantity === null) { e.quantity = 1; e.quantityImplicit = true; e.quantityAmbiguous = false; e.minConf = m.conf; }
    else e.minConf = minConf(e.minConf, m.conf);
  });

  // ---- 3. orphan numbers: a quantity NOT attached to an item ("make it three", "no wait, two", "yes three") ----
  // Eligible only AFTER a correction cue in this utterance, or when the whole utterance is a bare confirmation.
  // Applies to the item mentioned most recently BEFORE the number (else the last-mentioned item overall). Last one wins.
  const words = toks.filter((x) => !x.boundary).map((x) => x.t);
  const onlyBare = words.length > 0 && words.every((w) => BARE_OK.has(w) || w in NUMS || /^\d{1,2}$/.test(w));
  const cueStart = cuePosition(toks);
  const consumed = new Set(mentions.map((m) => m.qIdx).filter((x): x is number => x !== null));
  if ((cueStart >= 0 || onlyBare) && state.items.size > 0) {
    for (let i = 0; i < toks.length; i++) {
      if (consumed.has(i) || toks[i]!.boundary) continue;
      if (!onlyBare && i <= cueStart) continue;
      const tk = toks[i]!.t;
      if (!(tk in NUMS) && !/^\d{1,2}$/.test(tk)) continue; // articles and homophones never count as an orphan number
      const n = numberAt(toks, i);
      if (!n) continue;
      const before = [...mentions].filter((m) => m.end <= i).sort((a, b) => b.end - a.end)[0];
      const target = before ? state.items.get(before.item_id)! : [...state.items.values()].sort((a, b) => b.lastMention - a.lastMention)[0]!;
      target.quantity = n.value; target.quantityImplicit = false; target.quantityAmbiguous = false; target.removed = false; target.minConf = n.conf;
    }
  }

  // ---- 4. modifiers, attached by proximity (and only if the menu allows them for that item) ----
  const joined = toks.filter((x) => !x.boundary).map((x) => x.t).join(' ');
  const positions: number[] = []; // char offset of each non-boundary token in `joined`
  { let off = 0; for (const x of toks) { if (x.boundary) continue; positions.push(off); off += x.t.length + 1; } }
  const tokIndexOfChar = (c: number) => { let idx = 0; for (let j = 0; j < positions.length; j++) if (positions[j]! <= c) idx = j; return idx; };
  // mention positions in the non-boundary index space
  const nb = (rawIdx: number) => toks.slice(0, rawIdx).filter((x) => !x.boundary).length;
  const mp = mentions.map((m) => ({ ...m, s: nb(m.start), e: nb(m.end) }));
  let scratch = joined;
  for (const { id, re } of MOD_PHRASES) {
    for (const hit of scratch.matchAll(new RegExp(re.source, 'g'))) {
      const at = tokIndexOfChar(hit.index ?? 0);
      const allows = (item: string) => isAllowedModifier(item, id);
      const preceding = [...mp].filter((m) => m.e <= at && allows(m.item_id)).sort((a, b) => b.e - a.e)[0];
      const following = [...mp].filter((m) => m.s >= at && m.s - at <= 3 && allows(m.item_id)).sort((a, b) => a.s - b.s)[0];
      const fallback = [...state.items.values()].filter((e) => allows(e.item_id)).sort((a, b) => b.lastMention - a.lastMention)[0];
      // Fall back to an item from an EARLIER utterance only when THIS utterance mentions no item at all ("no onions" as a follow-up).
      // If it mentions items but none can take the modifier, drop it: attaching "big" (in "and a big burger") to an earlier coke
      // would invent evidence and could let a hallucinated modifier through.
      const target = preceding ? ensure(state, preceding.item_id, 0) : following ? ensure(state, following.item_id, 0) : mp.length === 0 ? fallback : undefined;
      if (!target || !KNOWN_MODS.has(id)) continue;
      const group = EXCLUSIVE.find((g) => g.includes(id));
      if (group) for (const g of group) target.modifiers.delete(g);
      target.modifiers.add(id);
    }
    // mask matched text so overlapping phrases (e.g. "chicken instead of beef" vs item alias "chicken") are not double counted
    scratch = scratch.replace(new RegExp(re.source, 'g'), (s) => ' '.repeat(s.length));
  }

  // ---- 5. pickup time ----
  const numbered = digitiseNumberWords(words).join(' ');
  if (/\b(asap|as soon as possible|right away|right now)\b/.test(joined)) state.pickup = { kind: 'asap' };
  else {
    const m = numbered.match(/\b(?:pick ?up|ready|at|around|by)\s+(?:at\s+)?(\d{1,2})(?:[: ](\d{2}))?\s*(am|pm)?\b/);
    if (m) {
      const hour = Number(m[1]); const minute = m[2] ? Number(m[2]) : 0;
      if (hour >= 1 && hour <= 12 && minute < 60) state.pickup = { kind: 'time', hour, minute, meridiem: (m[3] as 'am' | 'pm' | undefined) ?? null };
    }
  }
  return state;
}

export function extractEvidence(utterances: readonly EvidenceUtterance[]): EvidenceState {
  const s = newEvidenceState();
  for (const u of utterances) foldUtterance(s, u);
  return s;
}

export function evidencedQuantity(state: EvidenceState, item_id: string): number | null {
  const e = state.items.get(item_id);
  return e && !e.removed ? e.quantity : null;
}

/** Does `item_id`'s evidenced modifier set equal `mods` (order-insensitive)? */
export const sameMods = (a: ReadonlySet<string> | readonly string[], b: ReadonlySet<string> | readonly string[]): boolean => {
  const x = [...a].sort().join('|'); const y = [...b].sort().join('|');
  return x === y;
};

/** Convenience for the drift checker and tests. */
export function claimedItems(text: string): { item_id: string; quantity: number | null; explicit: boolean }[] {
  const s = extractEvidence([{ text }]);
  return [...s.items.values()].filter((e) => !e.removed).map((e) => ({ item_id: e.item_id, quantity: e.quantity, explicit: !e.quantityImplicit }));
}
