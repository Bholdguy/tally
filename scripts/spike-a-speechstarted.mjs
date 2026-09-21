import { readFileSync, readdirSync } from 'node:fs';
const D = 'fixtures/aai-events-A-hold';
const rows = [];
for (const f of readdirSync(D).filter(x => x.endsWith('.jsonl') && !x.endsWith('.stt.jsonl') && /(late|hold|barge)/.test(x)).sort()) {
  const L = readFileSync(`${D}/${f}`, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const S = readFileSync(`${D}/${f.replace('.jsonl', '.stt.jsonl')}`, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.dir === 'in');
  const mk = L.find(l => l.dir === 'marker' && l.label.startsWith('correction:'));
  const call = L.find(l => l.dir === 'in' && l.msg.type === 'tool.call' && l.msg.name === 'add_item');
  const sttSS = S.find(r => r.msg.type === 'SpeechStarted' && r.t_ms >= mk.t_ms - 100);
  const agSS = L.find(l => l.dir === 'in' && l.msg.type === 'input.speech.started' && l.t_ms >= mk.t_ms - 100);
  rows.push({ run: f.replace('.jsonl',''), stt_SpeechStarted_lag: sttSS ? Math.round(sttSS.t_ms - mk.t_ms) : 'never', agent_speech_started_lag: agSS ? Math.round(agSS.t_ms - mk.t_ms) : 'never', stt_SS_vs_call: sttSS ? Math.round(sttSS.t_ms - call.t_ms) : null, agent_SS_vs_call: agSS ? Math.round(agSS.t_ms - call.t_ms) : null });
}
console.table(rows);
const first = readFileSync(`${D}/late_correction_900ms-1.stt.jsonl`, 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(r => r.msg.type === 'SpeechStarted');
console.log('SpeechStarted payload example:', JSON.stringify(first.msg));
