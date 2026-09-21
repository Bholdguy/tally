// Aggregate every *.result.json in <dir> and evaluate the FIXED pass criteria (scripts/lib/real-speech.ts CRITERIA).
//   npx tsx scripts/real-speech-summary.ts [dir] [--md]      (--md writes docs/real-speech-validation-results.md)
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { CRITERIA, evaluate, type RunResult } from './lib/real-speech.js';

const dir = process.argv.slice(2).find((a) => !a.startsWith('-')) ?? 'data/real-speech';
const runs = readdirSync(dir).filter((f) => f.endsWith('.result.json')).map((f) => (JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as { result: RunResult }).result);
const e = evaluate(runs);
const L: string[] = [];
const P = (s = '') => { L.push(s); console.log(s); };
P(`# Real-speech validation results (${dir})`);
P(`Generated ${new Date().toISOString()}; ${runs.length} recordings. **OVERALL: ${e.pass ? 'PASS' : 'FAIL'}**${runs.length === 0 ? ' (no recordings: NOT RUN)' : ''}`);
P(`Criteria were fixed before any run: ${JSON.stringify(CRITERIA)}`);
P('\n| id | criterion | result | detail |\n|---|---|---|---|');
for (const c of e.criteria) P(`| ${c.id} | ${c.description} | **${c.pass ? 'PASS' : 'FAIL'}** | ${c.detail} |`);
P('\n## Recordings\n\n| recording | speaker | kind | noise | order = intent | status | evidence ok | calls (verdict/code) | stalls |\n|---|---|---|---|---|---|---|---|---|');
for (const r of runs) P(`| ${r.name} | ${r.speaker} | ${r.kind} | ${r.noise ?? ''} | ${r.order_diff.equal ? 'yes' : 'NO'} | ${r.final_status} | ${r.evidence_matches_intent ? 'yes' : 'NO'} | ${r.calls.map((c) => `${c.tool}:${c.verdict}${c.code ? '/' + c.code : ''}${c.content_matches_intent === false ? '*' : ''}`).join(', ')} | ${r.stalls} |`);
P('\n`*` = the call content did not match the speaker\'s intent (a hold there is a true positive).');
const bad = runs.filter((r) => !r.order_diff.equal || !r.evidence_matches_intent);
if (bad.length) { P('\n## Misses, with the independent-stream transcript (every miss must be explained)'); for (const r of bad) P(`- **${r.name}** order diff: ${JSON.stringify(r.order_diff)}; transcripts: ${JSON.stringify(r.evidence_transcripts)}`); }
if (process.argv.includes('--md')) writeFileSync('docs/real-speech-validation-results.md', L.join('\n') + '\n');
process.exit(runs.length === 0 ? 3 : e.pass ? 0 : 1);
