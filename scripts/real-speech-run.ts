// Run ONE real-speech recording through the ENTIRE real pipeline (real AssemblyAI Voice Agent + independent STT, production
// SessionRuntime, gate, SQLite) at real time, then score it against the speaker's written intent.
//   npx tsx --env-file-if-exists=.env scripts/real-speech-run.ts <recording.wav> <intent.json> [--out=data/real-speech]
// The recording should start with >= 0.5 s of silence (used to calibrate the room-noise floor for the local speech check).
// NOTE: a WAV cannot answer the agent, so this scores the gate's decisions and the evidence on the customer's real speech; it does
// not evaluate the repair conversation (Step 6) or interactive turn-taking. Those need a live microphone session.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadAgentConfig } from '../agent/src/config.js';
import { initDatabase } from '../db/src/index.js';
import { Store } from '../reliability/src/committer.js';
import { extractEvidence } from '../reliability/src/extractor.js';
import { reconcileTimeline } from '../reliability/src/reconcile.js';
import { SessionRuntime } from '../server/src/runtime.js';
import { fetchSessionTimeline } from '../stt/src/index.js';
import { diffOrder, estimateNoiseFloor, parseWav, sameOrder, toPcm24k, type CallOutcome, type Intent, type IntendedItem, type OrderLineLite, type RunResult } from './lib/real-speech.js';

const wavPath = process.argv[2]; const intentPath = process.argv[3];
if (!wavPath || !intentPath) { console.error('usage: real-speech-run.ts <recording.wav> <intent.json> [--out=dir]'); process.exit(2); }
const out = process.argv.find((a) => a.startsWith('--out='))?.split('=')[1] ?? 'data/real-speech';
const name = basename(wavPath).replace(/\.wav$/i, '');
const intent = JSON.parse(readFileSync(intentPath, 'utf8')) as Intent;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const pcm = toPcm24k(parseWav(new Uint8Array(readFileSync(wavPath))));
const floor = estimateNoiseFloor(pcm, 500);
mkdirSync(out, { recursive: true });
const dbPath = join(out, `${name}.sqlite`);
initDatabase(dbPath);
const store = new Store(dbPath);
const cfg = loadAgentConfig();

console.log(`${name}: ${(pcm.length / 48000).toFixed(1)} s of audio, calibrated noise floor RMS ${floor.toFixed(0)}`);
const rt = await SessionRuntime.start({ agentConfig: cfg, store, audioDir: join(out, 'audio'), mode: 'live', sessionId: `rs_${name}`, vad: { initialNoiseFloor: floor } });

// let the greeting finish so the recording starts from a settled state (as a caller would after hearing it)
await new Promise<void>((res) => { const off = rt.subscribe((e) => { if (e.kind === 'reply_done') { off(); res(); } }); setTimeout(() => { off(); res(); }, 15000); });
await sleep(400);
const t0 = Date.now();
for (let o = 0; o < pcm.length; o += 48000) await rt.sendPcm(pcm.subarray(o, Math.min(o + 48000, pcm.length)));
// silence tail, then wait until no new tool call has arrived for 4 s (max 25 s) so holds and late calls resolve
await rt.sendPcm(new Uint8Array(24000 * 2 * 3));
const count = () => (store.r.prepare('SELECT count(*) c FROM tool_calls WHERE session_id=?').get(rt.session_id) as { c: number }).c;
let last = count(); let stable = Date.now(); const deadline = Date.now() + 25000;
while (Date.now() < deadline && Date.now() - stable < 4000) { await rt.sendPcm(new Uint8Array(24000 * 2)); const c = count(); if (c !== last) { last = c; stable = Date.now(); } }
const durationMs = Date.now() - t0;
const summary = await rt.end();
const sid = rt.session_id;

// ---- score against the intent ----
const rows = store.r.prepare('SELECT id,tool_name,args_json,status,conflict_type,evidence_json,t_received_ms,t_verdict_ms FROM tool_calls WHERE session_id=? ORDER BY timestamp').all(sid) as any[];
const auditBefore = (tcId: string): OrderLineLite[] | null => {
  const a = store.r.prepare('SELECT before_state FROM audit_events WHERE tool_call_id=? AND before_state IS NOT NULL ORDER BY timestamp LIMIT 1').get(tcId) as { before_state: string } | undefined;
  return a ? (JSON.parse(a.before_state).lines as OrderLineLite[]) : null;
};
const intended = intent.intended.items;
const lineOf = (id: string) => intended.find((i) => i.item_id === id);
const matches = (row: any): boolean | null => {
  const args = JSON.parse(row.args_json ?? 'null') ?? {};
  switch (row.tool_name) {
    case 'add_item': { const l = lineOf(args.item_id); return !!l && l.quantity === args.quantity && sameOrder([{ ...l }], [{ item_id: args.item_id, quantity: args.quantity, modifiers: args.modifiers ?? [] }]); }
    case 'update_quantity': return lineOf(args.item_id)?.quantity === args.quantity;
    case 'apply_modifier': return !!lineOf(args.item_id)?.modifiers.includes(args.modifier);
    case 'remove_item': return !lineOf(args.item_id);
    case 'confirm_order': { const before = auditBefore(row.id); return before ? sameOrder(before, intended) && (intent.intended.pickup === 'ASAP' ? args.pickup_time === 'ASAP' : true) : null; }
    default: return null;
  }
};
const calls: CallOutcome[] = rows.map((r) => ({
  tool: r.tool_name, args: JSON.parse(r.args_json ?? 'null'), verdict: r.status === 'allowed' ? 'ALLOW' : 'HOLD', code: r.conflict_type, status: r.status,
  waited_ms: r.t_verdict_ms != null && r.t_received_ms != null ? Math.round(r.t_verdict_ms - r.t_received_ms) : null, content_matches_intent: matches(r),
}));

const finals = (store.r.prepare("SELECT text FROM utterances WHERE session_id=? AND source='independent_stt' AND is_partial=0 ORDER BY t_ms").all(sid) as { text: string }[]).map((u) => u.text);
const ev = extractEvidence(finals.map((text) => ({ text })));
const evOk = intended.every((i: IntendedItem) => { const e = ev.items.get(i.item_id); return !!e && !e.removed && e.quantity === i.quantity && [...e.modifiers].sort().join('|') === [...i.modifiers].sort().join('|'); })
  && [...ev.items.values()].every((e) => e.removed || intended.some((i) => i.item_id === e.item_id));
const order = store.getOrder(sid)!;
const stalls = rows.filter((r) => r.status !== 'allowed' && /silent while speech/.test(r.evidence_json ?? '')).length;
const runs = (store.r.prepare("SELECT count(*) c FROM vad_events WHERE session_id=? AND source='local' AND type='speech_start'").get(sid) as { c: number }).c;

let recon: number | null = null;
try {
  await sleep(6000);
  const aai = (store.r.prepare('SELECT aai_session_id a FROM sessions WHERE id=?').get(sid) as { a: string | null }).a;
  if (aai) {
    const tl = await fetchSessionTimeline({ apiKey: cfg.apiKey, restUrl: cfg.restUrl, sessionId: aai });
    const live = (store.r.prepare("SELECT text FROM utterances WHERE session_id=? AND source='agent_stream' AND speaker='user' AND is_partial=0").all(sid) as { text: string }[]).map((u) => u.text);
    recon = reconcileTimeline({ live, independent: finals, turns: tl.turns }, { minConfidence: 0.8 }).length;
  }
} catch { /* the timeline may not be ready; reported as null, never guessed */ }

const result: RunResult = {
  name, speaker: intent.speaker, kind: intent.kind, noise: intent.noise ?? null, duration_ms: durationMs, calls,
  final_order: order.state.lines, final_status: order.state.status, order_diff: diffOrder(order.state.lines, intended),
  evidence_matches_intent: evOk, evidence_transcripts: finals, local_speech_runs: runs, stalls,
  pending_evidence_holds: rows.filter((r) => r.conflict_type === 'PENDING_EVIDENCE').length, reconciliation_findings: recon, ingest_errors: summary.ingest.errors,
};
writeFileSync(join(out, `${name}.result.json`), JSON.stringify({ ran_at: new Date().toISOString(), intent, result }, null, 2));
store.close();
console.log(JSON.stringify({ name, order_equal: result.order_diff.equal, status: result.final_status, evidence_ok: evOk, calls: calls.map((c) => `${c.tool}:${c.verdict}${c.code ? '/' + c.code : ''}${c.content_matches_intent === false ? '(content!=intent)' : ''}`), stalls, recon }));
// let the agent/STT sockets finish closing (process.exit() while one is still closing aborts with a libuv assertion on Windows,
// the same class of bug fixed in smoke-deployed.ts); the real-speech batch runner treats a nonzero/crashed exit as "failed to
// run" even though the result was already written above, so this is not cosmetic: it was silently discarding good runs.
process.exitCode = 0;
setTimeout(() => process.exit(0), 2000).unref();
