import { readdirSync, readFileSync } from 'node:fs';
import { analyseRun, judge, type RawLine } from '../agent/src/spike/analyze.js';
const D = 'fixtures/aai-events';
const runs = readdirSync(D).filter((f) => f.endsWith('.jsonl')).sort().map((f) => ({ f, a: analyseRun(f.replace(/-\d+\.jsonl$/, ''), readFileSync(`${D}/${f}`, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as RawLine)) }));
for (const { f, a } of runs) for (const c of a.calls) if (c.spoke_before_call) console.log('SPOKE-BEFORE-CALL', f, c.tool, JSON.stringify(c.args), `loud=${c.loud_audio_before_call_ms}ms silent=${c.silent_audio_before_call_ms}ms stopped→call=${Math.round(c.stopped_to_call_ms ?? -1)}ms`);
const j = judge(runs.map((r) => r.a));
console.log(JSON.stringify(j.stats, null, 1)); console.log(j.verdict, j.reasons.join('\n'));
