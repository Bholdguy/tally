import { readFileSync, readdirSync } from 'node:fs';
function outcome(dir) {
  const rows = [];
  for (const f of readdirSync(dir).filter(x => x.endsWith('.jsonl') && !x.endsWith('.stt.jsonl') && /(late|hold|barge|inline)/.test(x)).sort()) {
    const L = readFileSync(`${dir}/${f}`, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    let finalQty = null, firstQty = null;
    for (const l of L) {
      if (l.dir === 'in' && l.msg.type === 'tool.call' && l.msg.name === 'add_item' && l.msg.arguments.item_id === 'burger' && firstQty === null) firstQty = l.msg.arguments.quantity;
      if (l.dir === 'out' && l.msg.type === 'tool.result') { try { const r = JSON.parse(l.msg.result); if (r.status === 'OK') { const b = (r.order || []).find(x => x.item_id === 'burger'); if (b) finalQty = b.quantity; } } catch {} }
    }
    const said = L.filter(l => l.dir === 'in' && l.msg.type === 'transcript.agent' && /burger/i.test(l.msg.text)).map(l => l.msg.text);
    const staleSpoken = said.some(t => /\b(two|2)\b/i.test(t));
    rows.push({ scenario: f.replace(/-\d+\.jsonl$/, ''), run: f.match(/-(\d+)\./)[1], first_call_qty: firstQty, final_committed_qty: finalQty, ok_final_is_3: finalQty === 3, agent_said_stale_two: staleSpoken });
  }
  return rows;
}
for (const [name, dir] of [['A (hold + independent STT)', 'fixtures/aai-events-A-hold'], ['B (interactive diagnostic)', 'fixtures/aai-events-B-interactive']]) {
  const r = outcome(dir);
  const corr = r.filter(x => x.scenario !== 'clean_order');
  console.log(`\n${name}: correction runs=${corr.length}  first call carried stale 2: ${corr.filter(x=>x.first_call_qty!==3).length}  ended with 3: ${corr.filter(x=>x.ok_final_is_3).length}  agent said stale two aloud: ${corr.filter(x=>x.agent_said_stale_two).length}`);
  console.table(corr);
}
