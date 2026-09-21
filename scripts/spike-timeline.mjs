import { readFileSync } from 'node:fs';
const lines = readFileSync(process.argv[2], 'utf8').trim().split('\n').map(l => JSON.parse(l));
let g = null;
const flush = () => { if (g) { console.log(`${g.t0.toFixed(0).padStart(6)}  in   audio x${g.n} ${g.t0.toFixed(0)}-${g.t1.toFixed(0)}ms  ${g.loud>0?`SPEECH(${g.loud} loud, maxrms=${g.max})`:'silence'}`); g = null; } };
for (const l of lines) {
  if (l.dir === 'marker') { flush(); if (!/^say:|^connected/.test(l.label)) console.log(`${l.t_ms.toFixed(0).padStart(6)}  ---- ${l.label}`); else console.log(`${l.t_ms.toFixed(0).padStart(6)}  ---- ${l.label}`); continue; }
  const m = l.msg, ty = m.type;
  if (l.dir==='out' && ty==='input.audio') continue;
  if (ty === 'reply.audio') { if (!g) g = { t0: l.t_ms, t1: l.t_ms, n: 0, loud: 0, max: 0 }; g.n++; g.t1 = l.t_ms; if ((m.rms??0) > 100) g.loud++; g.max = Math.max(g.max, m.rms??0); continue; }
  if (ty === 'transcript.agent.delta' || ty==='session.updated' || ty==='session.ready') continue;
  flush();
  let x = '';
  if (/^transcript\./.test(ty)) x = JSON.stringify(m.text) + (m.interrupted!==undefined?` interrupted=${m.interrupted}`:'');
  if (ty === 'reply.done') x = 'status=' + m.status;
  if (ty === 'tool.call') x = `${m.name} ${JSON.stringify(m.arguments)}`;
  if (ty === 'tool.result') x = m.result.slice(0, 70);
  if (ty==='session.update') continue;
  console.log(`${l.t_ms.toFixed(0).padStart(6)}  ${l.dir.padEnd(4)} ${ty} ${x}`);
}
flush();
