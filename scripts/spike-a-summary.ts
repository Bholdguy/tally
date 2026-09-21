// Summarise spike A/B captures: npx tsx scripts/spike-a-summary.ts <dir> [--json]
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { analyseSttRun, summarise } from '../agent/src/spike/analyze-stt.js';
import { analyseRun, type RawLine } from '../agent/src/spike/analyze.js';
import type { SttRaw } from '../stt/src/stream.js';

const dir = process.argv[2] ?? 'fixtures/aai-events-A-hold';
const read = <T>(f: string): T[] => readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as T);
const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl') && !f.endsWith('.stt.jsonl')).sort();

const facts = files.map((f) => {
  const primary = read<RawLine>(`${dir}/${f}`);
  const sttFile = `${dir}/${f.replace(/\.jsonl$/, '.stt.jsonl')}`;
  const stt = existsSync(sttFile) ? read<SttRaw>(sttFile) : [];
  const scenario = f.replace(/-\d+\.jsonl$/, '');
  const a = analyseSttRun(scenario, primary, stt);
  const p = analyseRun(scenario, primary);
  return { f, a, p };
});

console.log(`# ${dir}: ${files.length} runs\n`);
console.table(summarise(facts.map((x) => x.a)));

console.log('\n## per-run correction evidence');
for (const { f, a } of facts) for (const c of a.corrections) {
  console.log(`${f.padEnd(34)} qty_in_call=${String(c.call_qty).padEnd(4)} primary_live=${c.primary_delivered ? 'YES' : 'no '} stt_first=${c.stt_first_ms === null ? 'never' : Math.round(c.stt_first_ms - (c.t_call_ms ?? 0)) + 'ms vs call'} stt_final=${c.stt_final_ms === null ? 'never' : Math.round(c.stt_final_ms - (c.t_call_ms ?? 0)) + 'ms vs call'} lag_after_speech_end=${c.final_lag_after_speech_end_ms === null ? '-' : Math.round(c.final_lag_after_speech_end_ms) + 'ms'} turns_in_hold=${c.stt_turns_during_hold} text=${JSON.stringify(c.stt_text)}`);
}

console.log('\n## did the agent speak before the first tool.call (audible audio)?');
for (const { f, p } of facts) {
  const first = p.calls.find((c) => c.mutating);
  if (first) console.log(`${f.padEnd(34)} spoke_before_first_call=${first.spoke_before_call} loud=${first.loud_audio_before_call_ms}ms silent=${first.silent_audio_before_call_ms}ms`);
}
if (process.argv.includes('--json')) console.log(JSON.stringify(facts.map((x) => x.a), null, 1));
