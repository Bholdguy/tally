// Operator replay of a stored case (Step 8).
//   npx tsx --env-file-if-exists=.env scripts/replay-case.ts <case_id> [--tier=evidence|audio] [--k=3] [--db=./data/tally.sqlite] [--audio-dir=./data/audio]
// EVIDENCE tier: offline, deterministic PASS/FAIL against the current gating code. No network.
// AUDIO tier: streams the stored PCM at 1x through fresh LIVE agent sessions (needs ASSEMBLYAI_API_KEY; real time x k; billed by AssemblyAI).
//   Reported "k/3 passed", never "deterministic". The session's order is read from the database, never from the agent's words.
import { loadAgentConfig } from '../agent/src/config.js';
import { initDatabase } from '../db/src/index.js';
import { Store } from '../reliability/src/committer.js';
import { describeReplay, replayEvidence } from '../reliability/src/replay.js';
import { runAudioReplay } from '../server/src/replay-audio.js';
import { SessionRuntime } from '../server/src/runtime.js';

const arg = (n: string, d?: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const caseId = process.argv.slice(2).find((a) => !a.startsWith('-'));
if (!caseId) { console.error('usage: replay-case.ts <case_id> [--tier=evidence|audio] [--k=3]'); process.exit(2); }
const tier = arg('tier', 'evidence');
const dbPath = arg('db', './data/tally.sqlite')!;
initDatabase(dbPath);
const store = new Store(dbPath);

try {
  if (tier === 'evidence') {
    const r = await replayEvidence(store, caseId);
    console.log(`${r.label}   (${r.diff.reason}; basis ${r.diff.basis}; ${r.duration_ms.toFixed(0)} ms)`);
    console.log(r.diff_json);
    process.exit(r.result === 'pass' ? 0 : 1);
  } else if (tier === 'audio') {
    const agentConfig = loadAgentConfig(process.env);
    const audioDir = arg('audio-dir', './data/audio')!;
    const rep = await runAudioReplay({
      store, caseId, k: Number(arg('k', '3')),
      startRuntime: (b) => SessionRuntime.start({ agentConfig, store, audioDir, mode: b.mode }),
      onAttempt: (a) => console.log(`attempt ${a.attempt}: ${a.result.toUpperCase()} (${(a.duration_ms / 1000).toFixed(1)} s) ${JSON.stringify(a.diff)}`),
    });
    console.log(`\n${rep.label}  [audio tier, ${rep.k} live runs, ${(rep.duration_ms / 1000).toFixed(0)} s]  ${describeReplay('audio', rep.attempts.map((a) => a.result)).label}`);
    process.exit(rep.overall === 'pass' ? 0 : 1);
  } else { console.error('tier must be evidence or audio'); process.exit(2); }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(2);
} finally { store.close(); }
