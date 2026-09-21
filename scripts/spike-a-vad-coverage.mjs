import { readFileSync, readdirSync } from 'node:fs';
const D = 'fixtures/aai-events-A-hold';
const types = {};
for (const f of readdirSync(D).filter(x => x.endsWith('.stt.jsonl'))) for (const l of readFileSync(`${D}/${f}`, 'utf8').trim().split('\n')) { const r = JSON.parse(l); if (r.dir === 'in') types[r.msg.type] = (types[r.msg.type] || 0) + 1; }
console.log('independent-stream inbound message types:', types);
// local-VAD coverage: for each run with a correction, was correction audio being sent (or within a hangover after it) when the first add_item tool.call arrived?
const rows = [];
for (const f of readdirSync(D).filter(x => x.endsWith('.jsonl') && !x.endsWith('.stt.jsonl') && /(late|hold|barge)/.test(x)).sort()) {
  const L = readFileSync(`${D}/${f}`, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const mk = L.find(l => l.dir === 'marker' && l.label.startsWith('correction:'));
  const clip = L.find(l => l.dir === 'marker' && l.t_ms >= mk.t_ms && l.label.startsWith('say:'));
  const end = L.find(l => l.dir === 'marker' && l.t_ms >= mk.t_ms && l.label === 'end:' + clip.label.slice(4));
  const call = L.find(l => l.dir === 'in' && l.msg.type === 'tool.call' && l.msg.name === 'add_item' && l.msg.arguments.item_id === 'burger');
  const stt = readFileSync(`${D}/${f.replace('.jsonl', '.stt.jsonl')}`, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.dir === 'in' && r.msg.type === 'Turn');
  const fin = stt.find(r => r.t_ms >= mk.t_ms && r.msg.end_of_turn && /\b(3|three)\b/i.test(r.msg.transcript));
  const qty = call.msg.arguments.quantity;
  const sinceEnd = call.t_ms - end.t_ms;
  rows.push({ run: f.replace('.jsonl',''), qty, stale: qty !== 3, call_minus_corr_start: Math.round(call.t_ms - mk.t_ms), call_minus_corr_end: Math.round(sinceEnd), speech_in_flight_at_call: sinceEnd <= 0, within_800ms_hangover: sinceEnd <= 800, wait_for_final_after_call: Math.round(Math.max(0, fin.t_ms - call.t_ms)) });
}
console.table(rows);
const stale = rows.filter(r => r.stale);
console.log(`stale first calls: ${stale.length}; correction audio in flight at call: ${stale.filter(r=>r.speech_in_flight_at_call).length}; within 800ms hangover: ${stale.filter(r=>r.within_800ms_hangover).length}; max wait for final after call: ${Math.max(...stale.map(r=>r.wait_for_final_after_call))}ms`);
