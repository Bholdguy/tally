// Deterministic demo runner (Step 15).
//   npx tsx scripts/demo.ts <A|B|C|D|confidence|dropout|all> [--db=./data/demo.sqlite] [--fresh] [--json]
// Prerecorded audio through the REAL pipeline; the agent and the independent transcripts are SCRIPTED, so the same audio + config + fresh
// DB gives identical verdicts, orders, cases and counters. `--json` prints the normalised output (diff two runs to see it).
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { initDatabase } from '../db/src/index.js';
import { Store } from '../reliability/src/committer.js';
import { DEMO_BANNER, normalise, runAll, runScenario, SCENARIOS, type ScenarioName } from '../server/src/demo/scenarios.js';

const arg = (n: string, d?: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const flag = (n: string) => process.argv.includes(`--${n}`);
const which = process.argv.slice(2).find((a) => !a.startsWith('-')) ?? 'all';
const dbPath = arg('db', './data/demo.sqlite')!;
const audioDir = join(dirname(dbPath), 'demo-audio');
if (flag('fresh')) { for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(f, { force: true }); rmSync(audioDir, { recursive: true, force: true }); }
mkdirSync(dirname(dbPath), { recursive: true });
initDatabase(dbPath);
const store = new Store(dbPath);
const json = flag('json');
const log = (m: string) => { if (!json) console.log(m); };

try {
  log(DEMO_BANNER);
  const opts = { store, audioDir, onStep: (m: string) => log(`  ${m}`) };
  const results = which === 'all' ? await runAll(opts, ['A', 'B', 'C', 'D']) : SCENARIOS.includes(which as ScenarioName) ? [await runScenario(which as ScenarioName, opts)] : (() => { throw new Error(`unknown scenario "${which}" (A|B|C|D|confidence|dropout|all)`); })();
  if (json) console.log(normalise(results));
  else for (const r of results) {
    console.log(`\n== ${r.label}`);
    for (const s of r.sessions) {
      for (const v of s.verdicts) console.log(`   ${v.verdict.padEnd(5)} ${v.tool}${v.code ? ` ${v.code}` : ''}${v.waited ? ' (gate waited on independent evidence)' : ''}${v.repaired ? ' [repaired]' : ''}`);
      for (const rp of s.repairs) console.log(`   REPAIR ${rp}`);
      const o = s.final_order; console.log(`   final order: ${o ? `${JSON.stringify(o.lines)} total ${(o.total_cents / 100).toFixed(2)} (${o.status})` : 'none'}; barge-ins ${s.barge_ins}`);
    }
    if (r.replay) console.log(`   replay: ${r.replay.evidence.map((e) => `${e.version} ${e.label}`).join(' | ')} | audio ${r.replay.audio.version}: ${r.replay.audio.label}`);
    console.log(`   counters: cases ${r.counters.cases}, regression candidates ${r.counters.regression_candidates}, regressions ${r.counters.regressions}`);
  }
} finally { store.close(); }
void existsSync;
