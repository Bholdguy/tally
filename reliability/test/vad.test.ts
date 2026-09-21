import { describe, expect, it } from 'vitest';
import { LocalVad, type VadTransition } from '../src/vad.js';

const RATE = 24000;
const samples = (ms: number) => Math.round((ms * RATE) / 1000);

/** PCM16LE sine at `amp` peak (RMS = amp/√2) */
function tone(ms: number, amp: number, hz = 220): Uint8Array {
  const n = samples(ms);
  const out = new Uint8Array(n * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < n; i++) dv.setInt16(i * 2, Math.round(amp * Math.sin((2 * Math.PI * hz * i) / RATE)), true);
  return out;
}
const silence = (ms: number) => new Uint8Array(samples(ms) * 2);
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let k = 0; for (const x of p) { o.set(x, k); k += x.length; } return o; };
function run(pcm: Uint8Array, chunkMs = 20, opts = {}) {
  const out: VadTransition[] = [];
  const v = new LocalVad(opts, (t) => out.push(t));
  const step = samples(chunkMs) * 2;
  for (let o = 0; o < pcm.length; o += step) v.feed(pcm.subarray(o, Math.min(o + step, pcm.length)));
  return { out, v };
}

describe('LocalVad', () => {
  it('digital silence never triggers', () => expect(run(silence(3000)).out).toEqual([]));

  it('detects speech onset with an algorithmic lag of exactly onFrames*frame (40 ms) and reports where the speech really began', () => {
    const { out } = run(cat(silence(500), tone(1000, 8000), silence(1000)));
    const start = out.find((t) => t.state === 'speech_start')!;
    expect(start.acoustic_ms).toBe(500);
    expect(start.detected_ms).toBe(540);                     // 2 loud 20 ms frames
    expect(start.detected_ms - start.acoustic_ms).toBe(40);
  });

  it('ends speech only after the hangover (300 ms) of quiet, and reports the last loud instant', () => {
    const { out } = run(cat(silence(200), tone(1000, 8000), silence(1000)));
    const end = out.find((t) => t.state === 'speech_end')!;
    expect(end.acoustic_ms).toBe(1200);
    expect(end.detected_ms).toBe(1500);                      // 1200 + 300 hangover
  });

  it('a pause shorter than the hangover does not split speech; a longer pause does', () => {
    const short = run(cat(tone(500, 8000), silence(200), tone(500, 8000), silence(800)));
    expect(short.out.map((t) => t.state)).toEqual(['speech_start', 'speech_end']);
    const long = run(cat(tone(500, 8000), silence(500), tone(500, 8000), silence(800)));
    expect(long.out.map((t) => t.state)).toEqual(['speech_start', 'speech_end', 'speech_start', 'speech_end']);
  });

  it('a 20 ms click is not speech (needs two consecutive loud frames)', () => {
    expect(run(cat(silence(300), tone(20, 12000), silence(500))).out).toEqual([]);
  });

  it('low-level room noise below the absolute floor does not trigger', () => {
    expect(run(tone(3000, 100)).out).toEqual([]);            // RMS ≈ 71 << 300
  });

  it('a noisy room (RMS ≈ 400) DOES read as speech by default (known limitation, measured in the real-speech pass) but not once the floor is calibrated', () => {
    const noise = tone(2000, 566);                           // RMS ≈ 400
    expect(run(noise).out.map((t) => t.state)).toEqual(['speech_start']);
    const calibrated = new LocalVad({ initialNoiseFloor: 400 });
    expect(calibrated.feed(cat(noise, tone(600, 9000))).map((t) => t.state)).toEqual(['speech_start']); // only the real speech
  });

  it('is independent of how the audio is chunked (live 20 ms chunks == replay in one buffer)', () => {
    const pcm = cat(silence(300), tone(700, 7000), silence(600), tone(400, 9000), silence(900));
    const ref = JSON.stringify(run(pcm, 20).out);
    for (const chunkMs of [10, 13, 37, 100, 5000]) expect(JSON.stringify(run(pcm, chunkMs).out), `chunk ${chunkMs}`).toBe(ref);
  });

  it('is deterministic', () => {
    const pcm = cat(silence(300), tone(700, 7000), silence(900));
    expect(JSON.stringify(run(pcm).out)).toBe(JSON.stringify(run(pcm).out));
  });

  it('media time advances only with samples fed (so replay == live, rule 7)', () => {
    const { v } = run(tone(1000, 5000));
    expect(v.mediaMs).toBe(1000);
  });
});
