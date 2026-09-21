// One-off connectivity probe for the independent STT stream: feeds one clip at real time and prints Turn messages.
// Usage: npx tsx --env-file-if-exists=.env scripts/stt-probe.ts [clip] [sampleRate]
import { readFileSync } from 'node:fs';
import { SttStream } from '../stt/src/index.js';
import { loadAgentConfig } from '../agent/src/config.js';
import { paceChunks, silence, wavToPcm } from '../agent/src/audio.js';

const clip = process.argv[2] ?? 'inline_corr';
const rate = Number(process.argv[3] ?? 24000);
const cfg = loadAgentConfig();
const t0 = performance.now();
const stt = new SttStream({ apiKey: cfg.apiKey, sampleRate: rate, onTurn: (t) => console.log(`${Math.round(t.t_ms)}ms turn#${t.turn_order} eot=${t.end_of_turn} ${JSON.stringify(t.transcript)} minWordConf=${t.words.length ? Math.min(...t.words.map((w) => w.confidence)).toFixed(2) : 'n/a'}`), onRaw: (r) => { if ((r.msg as any).type === 'Begin') console.log('Begin', JSON.stringify(r.msg)); } });
try {
  await stt.connect();
  console.log(`connected in ${Math.round(performance.now() - t0)}ms (sample_rate=${rate})`);
  const pcm = wavToPcm(new Uint8Array(readFileSync(`fixtures/audio/spike/${clip}.wav`)));
  await paceChunks(pcm, (c) => stt.feed(c));
  await paceChunks(silence(2500), (c) => stt.feed(c));
} catch (e) { console.log('FAILED:', (e as Error).message); }
await stt.terminate();
console.log('turns:', stt.turns.length);
