// Prepares the demo database (Step 15 / demo lock). Run BEFORE going on stage:  npm run demo:seed [-- --db=./data/tally.sqlite --fresh]
//
// NOTHING IN THE DATABASE IS FABRICATED. The cases come from running the deterministic scenarios through the real pipeline (prerecorded
// audio; scripted agent and transcripts, labelled as such); "seeding" is exactly: play the scenarios, then ONE manual operator acceptance,
// so the promotion gate has a real regression case to block against instead of passing vacuously.
//   1. baseline config v1 is created and activated (from this build's prompt and gating parameters)
//   2. scenarios A, B, D (three corrections) and `confidence` x3 are played
//   3. the operator (this script, audit-logged as an operator action) accepts the confidence case as a regression: it protects the
//      transcription-confidence check, so a candidate that weakens that check is BLOCKED, naming the case
//   4. candidate configs are created (not promoted): v2 weakens the confidence floor (will be blocked), v3 changes only the wait budget
//      (will pass); their evidence-tier suite runs fill the compare table
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { initDatabase } from '../db/src/index.js';
import { runSuite } from '../reliability/src/promotion.js';
import { Store } from '../reliability/src/committer.js';
import { toolDeclarations } from '../contract/src/index.js';
import { runScenario, type ScenarioName } from '../server/src/demo/scenarios.js';

const arg = (n: string, d?: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const dbPath = arg('db', './data/tally.sqlite')!;
const audioDir = join(dirname(dbPath), 'demo-audio');
if (process.argv.includes('--fresh')) { for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(f, { force: true }); rmSync(audioDir, { recursive: true, force: true }); }
mkdirSync(dirname(dbPath), { recursive: true });
initDatabase(dbPath);
const store = new Store(dbPath);
const log = (m: string) => console.log(m);

try {
  const opts = { store, audioDir, onStep: (m: string) => log(`  ${m}`) };
  if (store.listCases().length > 0) log('note: this database already has cases; scenarios will add to them (use --fresh for a clean run)');
  const plan: ScenarioName[] = ['A', 'B', 'D', 'confidence', 'confidence', 'confidence'];
  for (const s of plan) await runScenario(s, opts);

  const conf = store.listCases().filter((c) => c.pattern_key.startsWith('UNVALIDATABLE|add_item|low_confidence'));
  const target = conf.find((c) => store.getCase(c.id)!.tag === 'regression_candidate' && store.getCase(c.id)!.resolution === 'resolved');
  if (!target) throw new Error('no resolved regression candidate from the confidence scenarios');
  const r = store.acceptRegression(target.id, 'operator');
  log(`operator accepted case ${target.id.slice(-8)} (${target.pattern_key}) as a regression: ${JSON.stringify(r)}`);

  const active = store.activeConfig()!;
  const tools = JSON.stringify(toolDeclarations());
  store.createConfig({ version: 'v2', prompt_text: active.prompt_text, tool_schema_json: tools, gating_params: { ...active.gating_params, minWordConfidence: 0.2 }, parent_version: active.version, actor: 'operator' });
  store.createConfig({ version: 'v3', prompt_text: active.prompt_text, tool_schema_json: tools, gating_params: { ...active.gating_params, evidenceWaitMaxMs: 3500 }, parent_version: active.version, actor: 'operator' });
  for (const v of ['v2', 'v3']) {
    const rep = await runSuite(store, { config_version: v });
    log(`suite for ${v}: ${rep.label}${rep.blocking.length ? ` (blocks: ${rep.blocking.map((b) => `${b.case_id?.slice(-8)} ${b.reason}`).join('; ')})` : ''}`);
  }
  const c = store.caseCounts();
  log(`\nready: ${c.cases} cases, ${c.candidates} candidates, ${c.regressions} regression(s); active config ${store.activeConfig()!.version}; v2 (weak confidence floor) is BLOCKED, v3 passes and can be promoted on stage.`);
} finally { store.close(); }
