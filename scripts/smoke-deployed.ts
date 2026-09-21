// Deployment smoke test.
//   npx tsx scripts/smoke-deployed.ts <base-url> <operator-token> [--scenarios=A,B,C,D,confidence,dropout|all] [--dry] [--adversarial] [--no-baseline]
//   npx tsx scripts/smoke-deployed.ts https://tally.example.com - --dry        # "-" reads the token from TALLY_OPERATOR_TOKEN
// Exit code 0 only if every check passes. `--dry` writes nothing to the target; without it the scenarios ADD demo sessions/cases to the
// target's database (run this BEFORE `npm run demo:seed -- --fresh`, or accept the extra rows). The token is never printed.
import { runSmoke } from './lib/smoke.js';
import { SCENARIOS, type ScenarioName } from '../server/src/demo/scenarios.js';

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const pos = args.filter((a) => !a.startsWith('--'));
const flag = (n: string) => flags.includes(`--${n}`);
const val = (n: string) => flags.find((f) => f.startsWith(`--${n}=`))?.slice(n.length + 3);
const [url, tokenArg] = pos;
const token = tokenArg === '-' ? process.env.TALLY_OPERATOR_TOKEN : tokenArg;
if (!url || !token) { console.error('usage: smoke-deployed.ts <base-url> <operator-token|-> [--scenarios=A,B|all] [--dry] [--adversarial] [--no-baseline]'); process.exit(2); }
if (!/^https?:\/\//.test(url)) { console.error('base-url must start with http:// or https://'); process.exit(2); }
const sc = val('scenarios');
const scenarios = !sc || sc === 'all' ? [...SCENARIOS] : (sc.split(',') as ScenarioName[]);
for (const s of scenarios) if (!(SCENARIOS as readonly string[]).includes(s)) { console.error(`unknown scenario "${s}"`); process.exit(2); }

console.log(`Smoke test against ${url}${flag('dry') ? ' (dry: nothing written)' : ''}\n`);
const r = await runSmoke(url, token, { scenarios, dry: flag('dry'), adversarial: flag('adversarial'), compareBaseline: !flag('no-baseline'), log: (l) => console.log(l) });
const failed = r.checks.filter((c) => !c.ok);
console.log(`\n${r.checks.length - failed.length}/${r.checks.length} checks passed${failed.length ? `; FAILED: ${failed.map((f) => f.name).join(' | ')}` : ''}`);
console.log('Not covered: a real browser (layout, microphone capture, playback) and the live managed agent.');
// let sockets finish closing (process.exit() while a WebSocket is still closing aborts with a libuv assertion on Windows); force the exit only if something lingers
process.exitCode = r.ok ? 0 : 1;
setTimeout(() => process.exit(process.exitCode), 2000).unref();
