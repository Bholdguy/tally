// Runs the corpus against the real gate and reports per-case verdicts. Any case not caught, or any clean call held, is a failure.
import { ADVERSARIAL_CORPUS, CLEAN_CORPUS, type Surface } from './corpus.js';
import { withGateOverride } from './harness.js';

export interface AdvRow { surface: Surface; name: string; what: string; expected: string; actual: string; caught: boolean }
export interface AdvReport {
  total: number; caught: number; uncaught: number; clean_total: number; false_positives: number;
  by_surface: Record<string, { total: number; caught: number }>; results: AdvRow[]; false_positive_cases: string[];
}

export async function runAdversarial(build: { gate?: Parameters<typeof withGateOverride>[0] } = {}): Promise<AdvReport> {
  return withGateOverride(build.gate ?? {}, runAll);
}

async function runAll(): Promise<AdvReport> {
  const results: AdvRow[] = [];
  for (const c of ADVERSARIAL_CORPUS) {
    let actual: string; let ok = false;
    try { const r = await c.run(); actual = r.actual; ok = r.ok; } catch (e) { actual = `THREW ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`; }
    results.push({ surface: c.surface, name: c.name, what: c.what, expected: c.expected, actual, caught: ok });
  }
  const fp: string[] = [];
  for (const c of CLEAN_CORPUS) {
    try { const r = await c.run(); if (r.verdict !== 'ALLOW') fp.push(`${c.name}: HOLD ${r.code}`); } catch (e) { fp.push(`${c.name}: THREW ${e instanceof Error ? e.message.slice(0, 60) : String(e)}`); }
  }
  const by: AdvReport['by_surface'] = {};
  for (const r of results) { by[r.surface] ??= { total: 0, caught: 0 }; by[r.surface]!.total++; if (r.caught) by[r.surface]!.caught++; }
  const caught = results.filter((r) => r.caught).length;
  return { total: results.length, caught, uncaught: results.length - caught, clean_total: CLEAN_CORPUS.length, false_positives: fp.length, by_surface: by, results, false_positive_cases: fp };
}

/** the human-readable catalogue (adversarial-cases.md), generated so it can never drift from the corpus */
export function corpusMarkdown(): string {
  const rows = (s: Surface) => ADVERSARIAL_CORPUS.filter((c) => c.surface === s).map((c) => `| ${c.name} | ${c.what} | \`${c.expected}\` |`).join('\n');
  const head = '| Case | The lie | Required outcome |\n|---|---|---|';
  return `# Adversarial cases

Generated from \`reliability/src/adversarial/corpus.ts\` (\`npm run adversarial -- --md\`). Every case is run against the REAL gate, evidence tracker, committer and SQLite (no mocks of the gate) on a virtual clock. A case is **caught** only if the actual outcome equals the required outcome shown here. The clean corpus (${CLEAN_CORPUS.length} valid calls) must ALL be allowed: false positives fail the run too.

## Gate (${ADVERSARIAL_CORPUS.filter((c) => c.surface === 'gate').length})
${head}
${rows('gate')}

## Repair (${ADVERSARIAL_CORPUS.filter((c) => c.surface === 'repair').length})
${head}
${rows('repair')}

## Spoken drift (${ADVERSARIAL_CORPUS.filter((c) => c.surface === 'drift').length})
${head}
${rows('drift')}

## Promotion gate and config registry (${ADVERSARIAL_CORPUS.filter((c) => c.surface === 'promotion').length})
${head}
${rows('promotion')}

## Clean corpus (must be ALLOWED)
| Case | What |
|---|---|
${CLEAN_CORPUS.map((c) => `| ${c.name} | ${c.what} |`).join('\n')}

## What this does NOT show
The corpus is authored by us: it proves the gate rejects the lies we thought of, not that it rejects every lie. Phrasing is synthetic; real speech will contain phrasings the extractor has not seen (see docs/real-speech-validation.md). An extractor miss fails toward holding (D-22), which the false-positive count measures only on this clean corpus.
`;
}
