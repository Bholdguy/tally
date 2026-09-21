// Run every <name>.wav that has a sibling <name>.intent.json in a folder, sequentially (each run is one real-time call).
//   npx tsx scripts/real-speech-batch.ts data/real-speech/recordings [--out=data/real-speech]
// Then:  npx tsx scripts/real-speech-summary.ts data/real-speech --md
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) { console.error('usage: real-speech-batch.ts <folder with NAME.wav + NAME.intent.json> [--out=dir]'); process.exit(2); }
const outArg = process.argv.find((a) => a.startsWith('--out=')) ?? '--out=data/real-speech';
const wavs = readdirSync(dir).filter((f) => /\.wav$/i.test(f)).sort();
let ran = 0; const skipped: string[] = []; const failed: string[] = [];
for (const w of wavs) {
  const intent = join(dir, w.replace(/\.wav$/i, '.intent.json'));
  if (!existsSync(intent)) { skipped.push(`${w} (no ${w.replace(/\.wav$/i, '.intent.json')})`); continue; }
  console.log(`\n=== ${w}`);
  const r = spawnSync('npx', ['tsx', '--env-file-if-exists=.env', 'scripts/real-speech-run.ts', join(dir, w), intent, outArg], { stdio: 'inherit', shell: true });
  if (r.status === 0) ran++; else failed.push(w);
}
console.log(`\nran ${ran}/${wavs.length}; skipped (no written intent): ${skipped.length ? skipped.join('; ') : 'none'}; failed to run: ${failed.length ? failed.join(', ') : 'none'}`);
process.exit(failed.length ? 1 : 0);
