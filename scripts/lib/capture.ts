// Reconstruct a spike-A capture into (a) the exact PCM Tally streamed, (b) local-VAD transitions on it, and (c) the
// evidence events (independent stream + local VAD) on the shared session clock, so the REAL gate can be replayed against
// REAL captured timelines (evidence-tier replay, rule 7: same code path as live).
import { readFileSync } from 'node:fs';
import type { TallyEvent } from '@tally/contract';
import { BYTES_PER_MS, wavToPcm } from '../../agent/src/audio.js';
import { LocalVad } from '../../reliability/src/vad.js';

export interface Capture {
  name: string;
  primary: any[];
  stt: any[];
  audioOut: { t_ms: number; audio_offset_ms: number }[];
  pcm: Uint8Array;
  tOfMedia: (ms: number) => number;
  events: (TallyEvent & { t_ms: number })[];   // evidence events, chronological
  localRuns: { start_t: number; end_t: number | null; acoustic_start_ms: number; detected_ms: number }[];
  call?: { t_ms: number; args: any; id: string };
}

const readJsonl = (f: string) => readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

export function loadCapture(dir: string, name: string, session = 's'): Capture {
  const primary = readJsonl(`${dir}/${name}.jsonl`);
  const stt = readJsonl(`${dir}/${name}.stt.jsonl`).filter((r: any) => r.dir === 'in');
  const audioOut = primary.filter((l: any) => l.dir === 'out' && l.msg?.type === 'input.audio') as Capture['audioOut'];
  const pcm = new Uint8Array(Math.round(audioOut.at(-1)!.audio_offset_ms * BYTES_PER_MS) & ~1);
  for (const mk of primary.filter((m: any) => m.dir === 'marker' && m.label.startsWith('say:'))) {
    const first = audioOut.find((a) => a.t_ms >= mk.t_ms - 1)!;
    const startMedia = first.audio_offset_ms - 20;
    const clip = wavToPcm(new Uint8Array(readFileSync(`fixtures/audio/spike/${mk.label.slice(4)}.wav`)));
    const at = Math.round(startMedia * BYTES_PER_MS) & ~1;
    pcm.set(clip.subarray(0, Math.max(0, pcm.length - at)), at);
  }
  const tOfMedia = (ms: number) => (audioOut.find((a) => a.audio_offset_ms >= ms) ?? audioOut.at(-1)!).t_ms;

  const vad = new LocalVad();
  const trans: { state: 'speech_start' | 'speech_end'; detected_ms: number; acoustic_ms: number }[] = [];
  for (let o = 0; o < pcm.length; o += 960) trans.push(...vad.feed(pcm.subarray(o, Math.min(o + 960, pcm.length))));

  const base = (t: number, i: number) => ({ id: `cap${i}`, session_id: session, t_ms: t, wall_ms: 0, audio_offset_ms: 0 });
  const events: Capture['events'] = [];
  let i = 0;
  for (const r of stt) {
    const m = r.msg;
    if (m.type === 'Begin') events.push({ ...base(r.t_ms, i++), kind: 'evidence_stream_status', status: 'up' } as never);
    else if (m.type === 'SpeechStarted') events.push({ ...base(r.t_ms, i++), kind: 'evidence_speech_started' } as never);
    else if (m.type === 'Turn') events.push({ ...base(r.t_ms, i++), kind: 'evidence_transcript', text: String(m.transcript ?? ''), end_of_turn: !!m.end_of_turn, turn_order: Number(m.turn_order ?? 0), words: (m.words ?? []).filter((w: any) => typeof w.confidence === 'number').map((w: any) => ({ text: w.text, confidence: w.confidence })) } as never);
  }
  const localRuns: Capture['localRuns'] = [];
  for (const t of trans) {
    const at = tOfMedia(t.detected_ms);
    events.push({ ...base(at, i++), kind: 'local_vad', state: t.state } as never);
    if (t.state === 'speech_start') localRuns.push({ start_t: at, end_t: null, acoustic_start_ms: t.acoustic_ms, detected_ms: t.detected_ms });
    else if (localRuns.length) localRuns[localRuns.length - 1]!.end_t = at;
  }
  events.sort((a, b) => a.t_ms - b.t_ms);
  const c = primary.find((l: any) => l.dir === 'in' && l.msg.type === 'tool.call' && l.msg.name === 'add_item' && l.msg.arguments?.item_id === 'burger');
  return { name, primary, stt, audioOut, pcm, tOfMedia, events, localRuns, call: c ? { t_ms: c.t_ms, args: c.msg.arguments, id: c.msg.call_id } : undefined };
}
