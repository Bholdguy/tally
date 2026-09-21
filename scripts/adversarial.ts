// npm run adversarial [-- --md]   Runs every seeded lie through the real gate; exit 1 if anything is missed or any clean call is held.
import { writeFileSync } from 'node:fs';
import { corpusMarkdown, runAdversarial } from '../reliability/src/adversarial/run.js';

if (process.argv.includes('--md')) { writeFileSync('adversarial-cases.md', corpusMarkdown()); console.log('wrote adversarial-cases.md'); }
const r = await runAdversarial();
for (const x of r.results) console.log(`${x.caught ? 'CAUGHT ' : 'MISSED '} [${x.surface}] ${x.name}  -> ${x.actual}${x.caught ? '' : `   (expected ${x.expected})`}`);
console.log(`\n${r.caught}/${r.total} caught; ${r.false_positives}/${r.clean_total} clean calls wrongly held`);
for (const [s, v] of Object.entries(r.by_surface)) console.log(`  ${s}: ${v.caught}/${v.total}`);
for (const f of r.false_positive_cases) console.log(`  FALSE POSITIVE: ${f}`);
process.exit(r.uncaught === 0 && r.false_positives === 0 ? 0 : 1);
