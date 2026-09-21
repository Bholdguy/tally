// DIRECT MEASUREMENT of the local speech-activity check on Tally's own input audio (replaces the inferred "11/11" claim).
// For each spike-A capture we reconstruct the EXACT PCM that was streamed: every input.audio record carries the cumulative
// audio offset, every clip start is a marker, and the clip bytes are the same fixture files. We run the production LocalVad
// over it in 20 ms chunks (as live) and measure: onset lag, lead over the independent SpeechStarted and the agent's
// input.speech.started, end-of-speech vs the independent final, and whether speech was flagged at each tool.call.
//   npx tsx scripts/measure-local-vad.ts [dir] [--md]
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { wavToPcm, BYTES_PER_MS } from '../agent/src/audio.js';
import { LocalVad } from '../reliability/src/vad.js';
import { EvidenceTracker } from '../reliability/src/evidence.js';
import { loadCapture } from './lib/capture.js';

const dir = process.argv.find((a) => a.startsWith('fixtures')) ?? 'fixtures/aai-events-A-hold';
const writeMd = process.argv.includes('--md');
const read = (f: string) => readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(p * xs.length) - 1)]! : NaN);
const fmt = (n: number) => (Number.isFinite(n) ? Math.round(n) : 'n/a');

interface Row { run: string; kind: string; onset_lag_media_ms: number[]; onset_lag_wall_ms: number[]; lead_over_stt_ms: number[]; lead_over_agent_ms: number[]; end_to_final_ms: number[]; call_flagged: boolean | null; unresolved_at_call: boolean | null; stale: boolean | null; corr_flag_after_call_ms: number | null; falseTriggers: number }
const rows: Row[] = [];
const allTransitions: { run: string; state: string; detected_ms: number; acoustic_ms: number }[] = [];

for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl') && !x.endsWith('.stt.jsonl')).sort()) {
  const L = read(`${dir}/${f}`);
  const stt = read(`${dir}/${f.replace('.jsonl', '.stt.jsonl')}`).filter((r: any) => r.dir === 'in');
  const audioOut = L.filter((l: any) => l.dir === 'out' && l.msg?.type === 'input.audio') as { t_ms: number; audio_offset_ms: number }[];
  if (!audioOut.length) continue;
  const totalMs = audioOut.at(-1)!.audio_offset_ms;
  const pcm = new Uint8Array(Math.round(totalMs * BYTES_PER_MS) & ~1);
  const markers = L.filter((l: any) => l.dir === 'marker');
  const clipWindows: { start: number; end: number; name: string }[] = [];
  for (const mk of markers.filter((m: any) => m.label.startsWith('say:'))) {
    const name = mk.label.slice(4);
    const first = audioOut.find((a) => a.t_ms >= mk.t_ms - 1)!;
    const startMedia = first.audio_offset_ms - 20; // each record's offset is cumulative AFTER its 20 ms chunk
    const clip = wavToPcm(new Uint8Array(readFileSync(`fixtures/audio/spike/${name}.wav`)));
    pcm.set(clip.subarray(0, Math.max(0, pcm.length - Math.round(startMedia * BYTES_PER_MS))), Math.round(startMedia * BYTES_PER_MS) & ~1);
    clipWindows.push({ start: startMedia, end: startMedia + clip.length / BYTES_PER_MS, name });
  }
  const tOfMedia = (ms: number) => (audioOut.find((a) => a.audio_offset_ms >= ms) ?? audioOut.at(-1)!).t_ms;

  const vad = new LocalVad();
  const trans: { state: string; detected_ms: number; acoustic_ms: number }[] = [];
  for (let o = 0; o < pcm.length; o += 960) trans.push(...vad.feed(pcm.subarray(o, Math.min(o + 960, pcm.length))));
  trans.forEach((t) => allTransitions.push({ run: f, ...t }));

  const starts = trans.filter((t) => t.state === 'speech_start');
  const ends = trans.filter((t) => t.state === 'speech_end');
  const sttSS = stt.filter((r: any) => r.msg.type === 'SpeechStarted').map((r: any) => r.t_ms as number);
  const sttFinals = stt.filter((r: any) => r.msg.type === 'Turn' && r.msg.end_of_turn).map((r: any) => r.t_ms as number);
  const agentSS = L.filter((l: any) => l.dir === 'in' && l.msg.type === 'input.speech.started').map((l: any) => l.t_ms as number);
  const call = L.find((l: any) => l.dir === 'in' && l.msg.type === 'tool.call' && l.msg.name === 'add_item' && l.msg.arguments.item_id === 'burger') as any;
  const corr = markers.find((m: any) => m.label.startsWith('correction:')) as any;

  const row: Row = { run: f.replace('.jsonl', ''), kind: f.replace(/-\d+\.jsonl$/, ''), onset_lag_media_ms: [], onset_lag_wall_ms: [], lead_over_stt_ms: [], lead_over_agent_ms: [], end_to_final_ms: [], call_flagged: null, unresolved_at_call: null, stale: null, corr_flag_after_call_ms: null, falseTriggers: 0 };
  for (const s of starts) {
    row.onset_lag_media_ms.push(s.detected_ms - s.acoustic_ms);
    const dT = tOfMedia(s.detected_ms); const aT = tOfMedia(s.acoustic_ms);
    row.onset_lag_wall_ms.push(dT - aT);
    const ss = sttSS.find((t) => t >= aT - 100); if (ss !== undefined) row.lead_over_stt_ms.push(ss - dT);
    const ag = agentSS.find((t) => t >= aT - 100); if (ag !== undefined) row.lead_over_agent_ms.push(ag - dT);
    if (!clipWindows.some((w) => s.acoustic_ms >= w.start - 40 && s.acoustic_ms <= w.end + 40)) row.falseTriggers++;
  }
  for (const e of ends) { const dT = tOfMedia(e.detected_ms); const fin = sttFinals.find((t) => t >= dT - 50); if (fin !== undefined) row.end_to_final_ms.push(fin - dT); }
  if (call) {
    const tc = call.t_ms as number;
    // was the local check flagging speech at the instant the tool.call arrived?
    row.call_flagged = starts.some((s, i) => tOfMedia(s.detected_ms) <= tc && (ends[i] === undefined || tOfMedia(ends[i]!.detected_ms) > tc)) ||
      starts.some((s) => tOfMedia(s.detected_ms) <= tc && !ends.some((e) => e.acoustic_ms >= s.acoustic_ms && tOfMedia(e.detected_ms) <= tc));
    // The gate's own definition: is the customer's speech UNRESOLVED at the call (speaking now, or ended with no independent final yet)?
    const cap = loadCapture(dir, row.run);
    const tr = new EvidenceTracker({ sttStallMs: 2500 });
    for (const e of cap.events) if (e.t_ms <= tc) tr.ingest(e);
    row.unresolved_at_call = tr.snapshot(tc).speechInFlight;
    row.stale = call.msg.arguments.quantity !== 3;
    if (corr) {
      const after = starts.map((s) => tOfMedia(s.detected_ms)).filter((t) => t >= corr.t_ms).sort((a, b) => a - b)[0];
      row.corr_flag_after_call_ms = after === undefined ? null : after - tc;
    }
  }
  rows.push(row);
}

const flat = <K extends keyof Row>(k: K) => rows.flatMap((r) => r[k] as number[]);
const corrRows = rows.filter((r) => r.kind !== 'clean_order' && r.kind !== 'inline_correction');
const stale = corrRows.filter((r) => r.stale);
const flagged = stale.filter((r) => r.unresolved_at_call);
const notFlagged = stale.filter((r) => !r.unresolved_at_call);
const speakingNow = stale.filter((r) => r.call_flagged);
const lines: string[] = [];
const P = (s = '') => { lines.push(s); console.log(s); };

P(`# Local speech-activity check: direct measurement (${dir})`);
P(`Generated ${new Date().toISOString()} by scripts/measure-local-vad.ts. Production LocalVad (defaults) run over the exact PCM streamed in ${rows.length} spike-A sessions.`);
P('**Synthetic SAPI speech + digital silence between clips: this measures the algorithm on clean audio. It says nothing about microphone noise (see TESTING.md §11).**\n');
P('## Onset detection lag');
P(`- algorithmic lag (speech began -> flag raised), media time: p50 ${fmt(pct(flat('onset_lag_media_ms'), 0.5))} ms, max ${fmt(Math.max(...flat('onset_lag_media_ms')))} ms  (n=${flat('onset_lag_media_ms').length} onsets)`);
P(`- same measured on the wall clock of the real streaming schedule: p50 ${fmt(pct(flat('onset_lag_wall_ms'), 0.5))} ms, p95 ${fmt(pct(flat('onset_lag_wall_ms'), 0.95))} ms, max ${fmt(Math.max(...flat('onset_lag_wall_ms')))} ms`);
P('\n## Lead over the other speech signals (positive = local check flagged EARLIER)');
P(`- vs independent stream SpeechStarted: p50 ${fmt(pct(flat('lead_over_stt_ms'), 0.5))} ms, min ${fmt(Math.min(...flat('lead_over_stt_ms')))} ms, max ${fmt(Math.max(...flat('lead_over_stt_ms')))} ms  (n=${flat('lead_over_stt_ms').length})`);
P(`- vs Voice Agent input.speech.started: p50 ${fmt(pct(flat('lead_over_agent_ms'), 0.5))} ms, min ${fmt(Math.min(...flat('lead_over_agent_ms')))} ms, max ${fmt(Math.max(...flat('lead_over_agent_ms')))} ms  (n=${flat('lead_over_agent_ms').length})`);
P('\n## End of speech vs the independent final');
P(`- local speech_end detected -> independent final arrives: p50 ${fmt(pct(flat('end_to_final_ms'), 0.5))} ms, max ${fmt(Math.max(...flat('end_to_final_ms')))} ms  (n=${flat('end_to_final_ms').length}); this is the wait the gate imposes after speech ends`);
P('\n## Coverage at each tool.call (late / during-hold / silent-reply barge runs)');
P(`- runs where the agent's FIRST call carried the stale quantity: ${stale.length}`);
P(`- customer speech **unresolved at the instant of the call** (the gate's own trigger to wait: speaking now, or ended with no independent final yet): **${flagged.length} of ${stale.length}**`);
P(`  - of those, the local check was actively flagging speech ("speaking now") at the call in ${speakingNow.length}; in the other ${flagged.length - speakingNow.length} the customer had just finished (speech_end already detected) but the independent final had not yet arrived`);
if (notFlagged.length) {
  P(`- NOT unresolved at the call: ${notFlagged.map((r) => r.run).join(', ')}`);
  P(`  - the correction began AFTER the call (local check flagged it ${notFlagged.map((r) => (r.corr_flag_after_call_ms === null ? 'never' : Math.round(r.corr_flag_after_call_ms) + ' ms after')).join(' / ')} the call). At decision time nobody was speaking, so the gate has nothing to wait on. This is an inherent limit of judging at call time; it is closed by the next call's validation and by the confirm-time reconciliation (D-22).`);
}
P(`- non-stale runs (the call already carried the corrected quantity): unresolved at call ${corrRows.filter((r) => !r.stale && r.unresolved_at_call).length} of ${corrRows.filter((r) => !r.stale).length} (the correction had long finished)`);
P('\n## False triggers (speech flagged where no clip was playing)');
P(`- ${rows.reduce((n, r) => n + r.falseTriggers, 0)} across ${rows.length} sessions (digital silence: not informative about real rooms)`);
P('\n## Per-run detail\n');
P('| run | onsets | lag media/wall (ms) | lead over stt SS (ms) | lead over agent SS (ms) | end→final (ms) | speaking at call | unresolved at call | stale call |');
P('|---|---|---|---|---|---|---|---|---|');
for (const r of rows) P(`| ${r.run} | ${r.onset_lag_media_ms.length} | ${r.onset_lag_media_ms.map(fmt).join('/')} / ${r.onset_lag_wall_ms.map(fmt).join('/')} | ${r.lead_over_stt_ms.map(fmt).join(', ')} | ${r.lead_over_agent_ms.map(fmt).join(', ')} | ${r.end_to_final_ms.map(fmt).join(', ')} | ${r.call_flagged === null ? '-' : r.call_flagged} | ${r.unresolved_at_call === null ? '-' : r.unresolved_at_call} | ${r.stale === null ? '-' : r.stale} |`);
if (writeMd) writeFileSync('docs/local-vad-measurement.md', lines.join('\n') + '\n');
