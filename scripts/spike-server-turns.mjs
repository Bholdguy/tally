import { readFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync('.env','utf8').split('\n').filter(l=>l.includes('=')&&!l.startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1).trim()]}));
const H = { headers: { Authorization: `Bearer ${env.ASSEMBLYAI_API_KEY}` } };
const base = env.AAI_REST_URL || 'https://agents.assemblyai.com';
for (const file of process.argv.slice(2)) {
  const lines = readFileSync(file,'utf8').trim().split('\n').map(l=>JSON.parse(l));
  const sid = lines.find(l=>l.dir==='in'&&l.msg.type==='session.ready').msg.session_id;
  const j = await (await fetch(`${base}/v1/sessions/${sid}`, H)).json();
  const tl = await (await fetch(j.artifacts.find(a=>a.type==='timeline').url)).json();
  const t0 = tl.started_at_unix_ms;
  console.log(`\n##### ${file.split('/').pop()}  (times = server ms since session start)`);
  for (const t of tl.turns) {
    const rel = (v)=> v==null?'-':String(v-t0);
    console.log(`turn trigger=${t.trigger} status=${t.status} user=${JSON.stringify(t.user_transcript)} speech[${rel(t.user_speech_started_at_ms)}..${rel(t.user_speech_ended_at_ms)}] agent=${JSON.stringify(t.agent_text)} reply[${rel(t.agent_reply_started_at_ms)}..${rel(t.agent_reply_ended_at_ms)}]`);
    for (const c of t.tool_calls||[]) console.log(`     tool ${c.name} ${JSON.stringify(c.arguments)} dispatched=${rel(c.dispatched_at_ms)} result_recv=${rel(c.result_received_at_ms)} dur=${c.duration_ms}ms`);
  }
}
