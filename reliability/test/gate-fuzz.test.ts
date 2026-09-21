// FAIL-CLOSED PROPERTY TEST (Step 5). 600 seeded random scenarios; an INDEPENDENT oracle (a few lines of arithmetic, not the
// gate's code path) decides what is allowed to happen. Properties:
//   SOUNDNESS     verdict ALLOW  =>  the oracle agrees it was safe; the order changed to exactly what the customer said.
//   FAIL CLOSED   oracle says "must hold" (stream not up, garbage args, no evidence, speech in flight, mid-wait drop,
//                 extractor/commit/sleep exceptions)  =>  HOLD and the order is byte-identical.
//   COMPLETENESS  oracle says "safe and correct" => ALLOW (no false holds on the clean corpus: metric 8).
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { initDatabase } from '@tally/db';
import { Store } from '../src/committer.js';
import { makeRig } from './rig.js';

const dbPath = join(mkdtempSync(join(tmpdir(), 'tally-fuzz-')), 't.sqlite');
initDatabase(dbPath);
const shared = new Store(dbPath);
afterAll(() => shared.close());

function mulberry32(a: number) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

type Speech = 'none' | 'forever' | 'stalled' | 'resolves' | 'dropMid';
type Fault = 'none' | 'extractThrows' | 'commitThrows' | 'sleepThrows';
interface Case {
  stream: 'up' | 'down' | 'unknown'; speech: Speech; fault: Fault;
  n: number; m: number | null; withFinals: boolean; q: number; garbage: unknown | null; seed: number;
}

function gen(seed: number): Case {
  const rnd = mulberry32(seed);
  const pick = <T,>(xs: [T, number][]): T => { let x = rnd() * xs.reduce((s, [, w]) => s + w, 0); for (const [v, w] of xs) { if ((x -= w) < 0) return v; } return xs[0]![0]; };
  const n = 1 + Math.floor(rnd() * 9);
  const m = rnd() < 0.5 ? 1 + Math.floor(rnd() * 9) : null;
  const intended = m ?? n;
  const q = rnd() < 0.5 ? intended : 1 + Math.floor(rnd() * 9);
  const garbage = pick<unknown | null>([[null, 88], [undefined as unknown as null, 2], [[] as unknown, 2], [{ item_id: 5 }, 2], [{ item_id: 'burger' }, 2], [{ item_id: 'burger', quantity: -1, modifiers: [] }, 2], [{ item_id: 'burger', quantity: 2, modifiers: [], x: 1 }, 2]]);
  return {
    stream: pick<Case['stream']>([['up', 78], ['down', 11], ['unknown', 11]]),
    speech: pick<Speech>([['none', 55], ['forever', 12], ['stalled', 10], ['resolves', 13], ['dropMid', 10]]),
    fault: pick<Fault>([['none', 78], ['extractThrows', 8], ['commitThrows', 8], ['sleepThrows', 6]]),
    n, m, withFinals: rnd() < 0.92, q, garbage: garbage === undefined ? undefined : garbage, seed,
  };
}

const textFor = (c: Case) => (c.m === null ? `${c.n} burgers.` : `${c.n} burgers. No, wait, make it ${c.m}.`);
const intendedQty = (c: Case) => c.m ?? c.n;

/** INDEPENDENT ORACLE: is it safe (and correct) for this scenario to end in ALLOW? Deliberately simple arithmetic. */
function oracle(c: Case): { mustHold: boolean; safeAndCorrect: boolean } {
  const goodArgs = c.garbage === null; // null means "use the valid args {burger, q}"
  const speechBlocks = c.speech === 'forever' || c.speech === 'stalled' || c.speech === 'dropMid';
  const faultBlocks = c.fault === 'extractThrows' || c.fault === 'commitThrows' || (c.fault === 'sleepThrows' && c.speech === 'resolves');
  const mustHold = c.stream !== 'up' || !goodArgs || !c.withFinals && c.speech !== 'resolves' || speechBlocks || faultBlocks;
  const safeAndCorrect = !mustHold && c.q === intendedQty(c);
  return { mustHold, safeAndCorrect };
}

async function runCase(c: Case) {
  let holder!: ReturnType<typeof makeRig>;
  const opts: Parameters<typeof makeRig>[0] = { sharedStore: shared, sharedPath: dbPath, session: `f${c.seed}` };
  if (c.fault === 'extractThrows') opts.extract = () => { throw new Error('injected extractor failure'); };
  if (c.fault === 'commitThrows') opts.commit = () => { throw new Error('injected commit failure'); };
  holder = makeRig(opts);
  const r = holder;
  if (c.fault === 'sleepThrows') r.clock.sleep = async () => { throw new Error('injected clock failure'); };
  if (c.stream === 'up') r.up(); else if (c.stream === 'down') r.down('fuzz');
  const text = textFor(c);
  if (c.withFinals && c.speech !== 'resolves') r.final(text);
  switch (c.speech) {
    case 'forever': r.localStart(); r.clock.at(400, () => r.speechStarted()); break;
    case 'stalled': r.localStart(); break;
    case 'dropMid': r.localStart(); r.clock.at(300, () => r.speechStarted()); r.clock.at(800 + (c.seed % 7) * 100, () => r.down('fuzz mid-wait drop')); break;
    case 'resolves': r.localStart(); r.clock.at(500, () => r.speechStarted()); r.clock.at(1500, () => { if (c.withFinals) r.final(text); r.localEnd(); }); break;
    default: break;
  }
  const args = c.garbage === null ? { item_id: 'burger', quantity: c.q, modifiers: [] } : c.garbage;
  const before = r.hash();
  const res = await r.call('add_item', args as never);
  const after = r.hash();
  const lines = r.store.getOrder(r.session)?.state.lines ?? [];
  return { res, before, after, lines, r };
}

describe('gate fail-closed property test (600 seeded scenarios, independent oracle)', () => {
  const N = 600;
  const results = { allow: 0, hold: 0, mustHold: 0, safe: 0, falseHold: 0 };

  it('SOUNDNESS, FAIL-CLOSED and COMPLETENESS hold for every scenario', async () => {
    for (let seed = 1; seed <= N; seed++) {
      const c = gen(seed);
      const { mustHold, safeAndCorrect } = oracle(c);
      const { res, before, after, lines } = await runCase(c);
      const ctx = `seed ${seed} ${JSON.stringify({ ...c, garbage: c.garbage === null ? null : 'garbage' })} -> ${res.verdict}${res.verdict === 'HOLD' ? ' ' + res.code : ''}`;

      if (res.verdict === 'ALLOW') {
        results.allow++;
        expect(mustHold, `UNSAFE ALLOW: ${ctx}`).toBe(false);                      // SOUNDNESS
        expect(c.q, `ALLOW of the wrong quantity: ${ctx}`).toBe(intendedQty(c));
        expect(lines, ctx).toEqual([{ item_id: 'burger', quantity: c.q, modifiers: [] }]);
      } else {
        results.hold++;
        expect(after, `HOLD changed the order: ${ctx}`).toBe(before);               // a hold is inert
        if (!mustHold && c.q !== intendedQty(c)) expect(res.code, ctx).toBe('QTY_MISMATCH');
      }
      if (mustHold) { results.mustHold++; expect(res.verdict, `must hold but did not: ${ctx}`).toBe('HOLD'); } // FAIL CLOSED
      if (safeAndCorrect) {
        results.safe++;
        if (res.verdict !== 'ALLOW') results.falseHold++;
        expect(res.verdict, `false hold on a safe, correct call: ${ctx}`).toBe('ALLOW'); // COMPLETENESS
      }
    }
    // the corpus must actually exercise all three regions, or the test proves nothing
    expect(results.allow).toBeGreaterThan(60);
    expect(results.hold).toBeGreaterThan(200);
    expect(results.mustHold).toBeGreaterThan(200);
    expect(results.safe).toBeGreaterThan(40);
    expect(results.falseHold).toBe(0);
    console.log(`fuzz corpus: ${N} scenarios, ALLOW ${results.allow}, HOLD ${results.hold}, oracle must-hold ${results.mustHold}, safe-and-correct ${results.safe}, false holds ${results.falseHold}`);
  }, 120000);

  it('is deterministic: the same seed produces the same verdict', async () => {
    for (const seed of [7, 42, 199, 512]) {
      const a = await runCase({ ...gen(seed), seed: seed + 10000 });
      const b = await runCase({ ...gen(seed), seed: seed + 20000 });
      expect(JSON.stringify([a.res.verdict, a.res.verdict === 'HOLD' ? a.res.code : null])).toBe(JSON.stringify([b.res.verdict, b.res.verdict === 'HOLD' ? b.res.code : null]));
    }
  });

  it('a HOLD is never converted into an ALLOW by retrying with a new call id while the fault persists', async () => {
    const c: Case = { ...gen(3), stream: 'down', speech: 'none', fault: 'none', withFinals: true, garbage: null, q: 2, n: 2, m: null, seed: 90001 };
    const { r } = await runCase(c);
    for (let i = 0; i < 5; i++) expect((await r.call('add_item', { item_id: 'burger', quantity: 2, modifiers: [] })).verdict).toBe('HOLD');
    expect(createHash('sha256').update(JSON.stringify(r.store.getOrder(r.session)?.state.lines)).digest('hex')).toBe(createHash('sha256').update('[]').digest('hex'));
  });
});
