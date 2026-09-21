// Option C on real captures: reconcile live stream + independent STT + stored timeline for each session in <dir>.
// Usage: npx tsx scripts/spike-reconcile.ts <dir>
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { reconcileTimeline } from '../reliability/src/reconcile.js';

const dir = process.argv[2] ?? 'fixtures/aai-events-A-hold';
const read = (f: string) => readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const conf: number[] = [];
const tally: Record<string, number> = {};
let sessions = 0;

for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl') && !x.endsWith('.stt.jsonl')).sort()) {
  const tlFile = `${dir}/${f.replace(/\.jsonl$/, '.timeline.json')}`;
  const sttFile = `${dir}/${f.replace(/\.jsonl$/, '.stt.jsonl')}`;
  if (!existsSync(tlFile) || !existsSync(sttFile)) continue;
  sessions++;
  const primary = read(`${dir}/${f}`);
  const stt = read(sttFile);
  const tl = JSON.parse(readFileSync(tlFile, 'utf8'));
  const live = primary.filter((l: any) => l.dir === 'in' && l.msg?.type === 'transcript.user').map((l: any) => l.msg.text as string);
  const independent = stt.filter((r: any) => r.dir === 'in' && r.msg?.type === 'Turn' && r.msg.end_of_turn).map((r: any) => r.msg.transcript as string);
  for (const t of tl.turns) if (typeof t.user_confidence === 'number') conf.push(t.user_confidence);
  const findings = reconcileTimeline({ live, independent, turns: tl.turns }, { minConfidence: 0.8 });
  const codes = findings.map((x) => x.code);
  for (const c of codes) tally[c] = (tally[c] ?? 0) + 1;
  console.log(`${f.padEnd(34)} live=${live.length} indep=${independent.length} timeline_user_turns=${tl.turns.filter((t: any) => t.user_transcript).length} findings=${JSON.stringify(codes)}`);
}
const sorted = [...conf].sort((a, b) => a - b);
console.log(`\nsessions reconciled: ${sessions}`);
console.log('finding totals:', tally);
console.log(`user_confidence values seen: n=${conf.length} min=${sorted[0]} max=${sorted.at(-1)} distinct=${[...new Set(conf)].length}`, [...new Set(conf)].slice(0, 8));
