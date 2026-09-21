// Builds a SYNTHETIC recording (SAPI clips) to smoke-test scripts/real-speech-run.ts. It is NOT real speech and is written to a
// separate dry-run folder so it can never be counted toward the real-speech pass.
import { readFileSync, writeFileSync } from 'node:fs';
import { concat, silence, wavToPcm } from '../agent/src/audio.js';

const clip = (n: string) => wavToPcm(new Uint8Array(readFileSync(`fixtures/audio/spike/${n}.wav`)));
const pcm = concat(silence(800), clip('inline_corr'), silence(1500), clip('pickup_asap'), silence(1000));

const header = new Uint8Array(44); const dv = new DataView(header.buffer);
const w = (o: number, s: string) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
w(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
dv.setUint32(24, 24000, true); dv.setUint32(28, 48000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, pcm.length, true);
writeFileSync('fixtures/audio/dryrun-inline.wav', concat(header, pcm));
console.log(`wrote fixtures/audio/dryrun-inline.wav (${(pcm.length / 48000).toFixed(1)} s, synthetic)`);
