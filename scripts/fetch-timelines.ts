// Download the stored AssemblyAI session timeline for every captured session in <dir> and save it next to the capture
// as <name>.timeline.json (real fixtures for option C reconciliation tests). Key is read server-side from .env only.
// Usage: npx tsx --env-file-if-exists=.env scripts/fetch-timelines.ts <dir>
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadAgentConfig } from '../agent/src/config.js';
import { fetchSessionTimeline } from '../stt/src/index.js';

const dir = process.argv[2] ?? 'fixtures/aai-events-A-hold';
const cfg = loadAgentConfig();
let ok = 0;
let failed = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl') && !x.endsWith('.stt.jsonl')).sort()) {
  const out = `${dir}/${f.replace(/\.jsonl$/, '.timeline.json')}`;
  if (existsSync(out)) continue;
  const ready = readFileSync(`${dir}/${f}`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.dir === 'in' && l.msg?.type === 'session.ready');
  if (!ready) { console.log(`${f}: no session.ready`); failed++; continue; }
  try {
    const tl = await fetchSessionTimeline({ apiKey: cfg.apiKey, restUrl: cfg.restUrl, sessionId: ready.msg.session_id });
    writeFileSync(out, JSON.stringify(tl, null, 1));
    ok++;
  } catch (e) { console.log(`${f}: ${(e as Error).message}`); failed++; }
}
console.log(`timelines saved: ${ok}, failed: ${failed}`);
