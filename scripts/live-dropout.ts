// LIVE dropout test against the REAL AssemblyAI streaming API (Step 4/5 owner requirement): does the gate fail closed?
//   npx tsx --env-file-if-exists=.env scripts/live-dropout.ts
// Real stream (universal-3-5-pro), real audio (SAPI clips), production LocalVad, production EvidenceTracker and Gate on the
// system clock, real SQLite. Scenarios:
//   mid     : correction audio in flight, a gate call is waiting, the socket is severed 250 ms later
//   before  : the socket is severed BEFORE the call arrives
//   control : healthy stream; the same call must wait for the real final and HOLD QTY_MISMATCH (proves the live path works)
// Pass criteria: dropouts => HOLD UNVALIDATABLE promptly (bounded, no hang), order unchanged; control => HOLD QTY_MISMATCH(3).
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TallyEvent } from '@tally/contract';
import { initDatabase } from '../db/src/index.js';
import { loadAgentConfig } from '../agent/src/config.js';
import { paceChunks, silence, wavToPcm } from '../agent/src/audio.js';
import { Store } from '../reliability/src/committer.js';
import { EvidenceTracker } from '../reliability/src/evidence.js';
import { Gate } from '../reliability/src/gate.js';
import { LocalVad } from '../reliability/src/vad.js';
import { systemClock } from '../reliability/src/clock.js';
import { createEvidenceStream } from '../stt/src/index.js';

const cfg = loadAgentConfig();
const clip = (n: string) => wavToPcm(new Uint8Array(readFileSync(`fixtures/audio/spike/${n}.wav`)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: Record<string, unknown>[] = [];

async function scenario(mode: 'mid' | 'before' | 'control') {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'tally-live-')), 't.sqlite');
  initDatabase(dbPath);
  const store = new Store(dbPath);
  const session = `live-${mode}`;
  store.createSession({ id: session, mode: 'demo', config_version: 'v1' });
  store.openOrder(session);
  const tracker = new EvidenceTracker({ sttStallMs: 2500 });
  const gate = new Gate({ store, evidenceFor: () => tracker, clock: systemClock, evidenceWaitMaxMs: 4000 });
  const push = (e: Record<string, unknown>) => tracker.ingest({ id: `e${randomUUID()}`, session_id: session, t_ms: performance.now(), wall_ms: Date.now(), audio_offset_ms: 0, ...e } as TallyEvent);
  const vad = new LocalVad({}, (t) => push({ kind: 'local_vad', state: t.state }));
  const stream = createEvidenceStream({ apiKey: cfg.apiKey, session_id: session, clock: () => performance.now(), sink: (e) => tracker.ingest(e) });
  const orderHash = () => createHash('sha256').update(JSON.stringify(store.r.prepare('SELECT * FROM orders').all())).digest('hex');

  const t0 = performance.now();
  await stream.connect();
  const connectMs = performance.now() - t0;
  const abort = new AbortController();
  const feed = (pcm: Uint8Array) => { stream.feed(pcm); vad.feed(pcm); };
  let corrStart = 0; let corrStarted!: () => void; const corrP = new Promise<void>((r) => (corrStarted = r));
  const feeder = (async () => {
    await paceChunks(clip('two_burgers'), feed, { signal: abort.signal });
    await paceChunks(silence(1800), feed, { signal: abort.signal });          // let the first turn finalise
    corrStart = performance.now(); corrStarted();
    await paceChunks(clip('no_wait_three'), feed, { signal: abort.signal });   // the correction: "No wait, make it three."
    await paceChunks(silence(3500), feed, { signal: abort.signal });
  })().catch(() => undefined);

  await corrP;
  if (mode === 'before') { await sleep(300); stream.sever(); await sleep(50); }
  await sleep(mode === 'before' ? 650 : 1000);                                 // ~1 s into the correction: speech in flight, stream has signalled
  const before = orderHash();
  const snapAtCall = tracker.snapshot(performance.now());
  let tSever = 0;
  const tCall = performance.now();
  const callP = gate.submit({ session_id: session, aai_call_id: `live-${mode}-1`, tool: 'add_item', args: { item_id: 'burger', quantity: 2, modifiers: [] }, received_t_ms: tCall });
  if (mode === 'mid') setTimeout(() => { tSever = performance.now(); stream.sever(); }, 250);
  const res = await callP;
  const tRes = performance.now();
  const after = orderHash();
  abort.abort();
  await stream.terminate().catch(() => undefined);
  await feeder;
  store.close();

  const held = res.verdict === 'HOLD';
  const code = held ? res.code : null;
  const expectCode = mode === 'control' ? 'QTY_MISMATCH' : 'UNVALIDATABLE';
  const promptMs = mode === 'mid' ? tRes - tSever : tRes - tCall;
  const pass = held && code === expectCode && before === after && (mode === 'control' ? true : promptMs < 500);
  const row = {
    scenario: mode, pass, verdict: res.verdict, code, expectCode, orderUnchanged: before === after,
    stream_status_at_call: snapAtCall.streamStatus, speech_in_flight_at_call: snapAtCall.speechInFlight,
    gate_total_ms: Math.round(tRes - tCall), verdict_after_sever_ms: mode === 'mid' ? Math.round(tRes - tSever) : null,
    waited_ms: held || res.verdict === 'ALLOW' ? Math.round(res.waited_ms ?? 0) : null,
    detail: held ? res.detail : null, repair: held ? res.repair?.ask_text ?? null : null, real_stream_connect_ms: Math.round(connectMs),
  };
  results.push(row);
  console.log(JSON.stringify(row));
}

for (const m of ['mid', 'before', 'control'] as const) {
  try { await scenario(m); } catch (e) { results.push({ scenario: m, pass: false, error: (e as Error).message }); console.log(`FAILED ${m}: ${(e as Error).message}`); }
}
mkdirSync('docs', { recursive: true });
writeFileSync('docs/step5-live-dropout.json', JSON.stringify({ ran_at: new Date().toISOString(), note: 'Real AssemblyAI streaming API, synthetic SAPI speech, single run per scenario.', results }, null, 2));
const ok = results.every((r) => r.pass === true);
console.log(ok ? '\nLIVE DROPOUT: PASS (fails closed, promptly, order unchanged)' : '\nLIVE DROPOUT: FAIL');
process.exit(ok ? 0 : 1);
