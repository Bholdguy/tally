// STEP 14: the adversarial harness as a test. Every seeded lie must be caught, every clean call allowed, the catalogue must match the
// corpus, and a deliberately BROKEN build must make the harness fail (so a green run means something).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADVERSARIAL_CORPUS, CLEAN_CORPUS } from '../src/adversarial/corpus.js';
import { corpusMarkdown, runAdversarial } from '../src/adversarial/run.js';

describe('adversarial harness (real gate, real committer, real SQLite)', () => {
  it('catches 100% of the seeded lies and holds none of the clean calls; every surface is covered', async () => {
    const r = await runAdversarial();
    const missed = r.results.filter((x) => !x.caught).map((x) => `${x.surface}/${x.name}: ${x.actual} (expected ${x.expected})`);
    expect(missed).toEqual([]);
    expect(r.false_positive_cases).toEqual([]);
    expect(r).toMatchObject({ uncaught: 0, false_positives: 0, total: ADVERSARIAL_CORPUS.length, clean_total: CLEAN_CORPUS.length });
    // the extension to Steps 6-10 is real, not nominal: each new surface has substantial coverage
    expect(r.by_surface.gate!.total).toBeGreaterThanOrEqual(35);
    expect(r.by_surface.repair!.total).toBeGreaterThanOrEqual(5);
    expect(r.by_surface.drift!.total).toBeGreaterThanOrEqual(8);
    expect(r.by_surface.promotion!.total).toBeGreaterThanOrEqual(30);
    expect(ADVERSARIAL_CORPUS.length).toBeGreaterThanOrEqual(80);
    expect(CLEAN_CORPUS.length).toBeGreaterThanOrEqual(15);
  }, 120000);

  it('the PRD Step 14 list is all present by name: wrong qty/item, phantom add, dropped correction, stale evidence, lying tool, different qty written, spoken total off, missing transcript, malformed args, duplicate id, out-of-order events, dropped VAD', () => {
    const names = ADVERSARIAL_CORPUS.map((c) => c.name).join(' | ');
    for (const needle of ['wrong quantity', 'wrong item', 'phantom add', 'dropped correction', 'stale evidence', 'nothing was written', 'different quantity', 'spoken total off by a dollar', 'nothing said', 'malformed', 'duplicate call id', 'out-of-order', 'VAD']) expect(names, needle).toContain(needle);
  });

  it('a deliberately BROKEN gate (no evidence wait, no confidence floor) makes the harness FAIL: a green run is not automatic', async () => {
    const r = await runAdversarial({ gate: { evidenceWaitMaxMs: 0, minWordConfidence: 0 } });
    expect(r.uncaught).toBeGreaterThanOrEqual(2);
    const names = r.results.filter((x) => !x.caught).map((x) => x.name);
    expect(names.some((n) => /stale evidence/.test(n))).toBe(true);
    expect(names.some((n) => /low word confidence/.test(n))).toBe(true);
  }, 120000);

  it('the checked-in catalogue (adversarial-cases.md) is exactly what the corpus generates', () => {
    expect(readFileSync(join(process.cwd(), 'adversarial-cases.md'), 'utf8')).toBe(corpusMarkdown());
  });
});
