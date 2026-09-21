// Local speech-activity check (Step 4 scope, D-04 evidence design). Energy VAD on Tally's OWN input PCM: it knows the
// customer is speaking with no network round-trip, bridging the ~0.5 s before the independent stream's SpeechStarted.
// Input audio only (rule: Tally has no path to voice OUTPUT). Deterministic, pure, no timers.
//
// Design: 20 ms frames; onset needs `onFrames` consecutive loud frames; offset needs `offHangoverMs` of quiet frames.
// Thresholds adapt to a slowly-tracked noise floor so a noisy room does not read as speech. Media time advances only
// with samples fed, so results are identical whether audio is live or replayed (rule 7).
export interface VadOptions {
  sampleRate?: number;   // default 24000
  frameMs?: number;      // default 20
  onFrames?: number;     // consecutive loud frames to declare speech, default 2 (40 ms)
  offHangoverMs?: number;// quiet time before declaring speech over, default 300
  onAbsRms?: number;     // absolute minimum RMS for "loud", default 300 (PCM16 scale 0..32768)
  offAbsRms?: number;    // default 150
  floorMultOn?: number;  // loud = max(onAbsRms, floor * floorMultOn), default 4
  floorMultOff?: number; // default 2
  /** seed the noise floor (RMS) from a calibration of the room, e.g. the first seconds of a session before anyone speaks */
  initialNoiseFloor?: number;
}

export interface VadTransition {
  state: 'speech_start' | 'speech_end';
  /** media time (ms of audio fed so far) at which the VAD could KNOW this: end of the confirming frame */
  detected_ms: number;
  /** media time where the speech actually began (start of the first loud frame) / where it last was loud */
  acoustic_ms: number;
}

export class LocalVad {
  private readonly o: Required<Omit<VadOptions, 'initialNoiseFloor'>>;
  private buf: Uint8Array = new Uint8Array(0);
  private frameIdx = 0;
  private floor = 0;
  private loudRun = 0;
  private firstLoudFrame = -1;
  private quietMs = 0;
  private lastLoudEndMs = 0;
  private inSpeech = false;

  constructor(opts: VadOptions = {}, private readonly onTransition?: (t: VadTransition) => void) {
    const { initialNoiseFloor, ...rest } = opts;
    this.o = { sampleRate: 24000, frameMs: 20, onFrames: 2, offHangoverMs: 300, onAbsRms: 300, offAbsRms: 150, floorMultOn: 4, floorMultOff: 2, ...rest };
    this.floor = initialNoiseFloor ?? 0;
  }

  get speaking(): boolean { return this.inSpeech; }
  /** ms of audio fed and fully framed so far */
  get mediaMs(): number { return this.frameIdx * this.o.frameMs; }
  get noiseFloor(): number { return this.floor; }

  private frameBytes(): number { return Math.round((this.o.frameMs * this.o.sampleRate * 2) / 1000) & ~1; }

  feed(pcm: Uint8Array): VadTransition[] {
    const out: VadTransition[] = [];
    const merged = new Uint8Array(this.buf.byteLength + pcm.byteLength);
    merged.set(this.buf); merged.set(pcm, this.buf.byteLength);
    const fb = this.frameBytes();
    let o = 0;
    for (; o + fb <= merged.byteLength; o += fb) {
      const t = this.frame(merged.subarray(o, o + fb));
      if (t) { out.push(t); this.onTransition?.(t); }
    }
    this.buf = merged.slice(o);
    return out;
  }

  private static rms(frame: Uint8Array): number {
    const n = frame.byteLength >> 1;
    if (!n) return 0;
    const dv = new DataView(frame.buffer, frame.byteOffset, n * 2);
    let sum = 0;
    for (let i = 0; i < n; i++) { const s = dv.getInt16(i * 2, true); sum += s * s; }
    return Math.sqrt(sum / n);
  }

  private frame(frame: Uint8Array): VadTransition | null {
    const idx = this.frameIdx++;
    const startMs = idx * this.o.frameMs;
    const endMs = startMs + this.o.frameMs;
    const r = LocalVad.rms(frame);
    const on = Math.max(this.o.onAbsRms, this.floor * this.o.floorMultOn);
    const off = Math.max(this.o.offAbsRms, this.floor * this.o.floorMultOff);
    const loud = this.inSpeech ? r >= off : r >= on;

    if (!this.inSpeech) {
      // track the noise floor only from non-loud frames (fast down, slow up)
      if (!loud) this.floor = r < this.floor ? this.floor * 0.9 + r * 0.1 : this.floor * 0.995 + r * 0.005;
      if (loud) {
        if (this.loudRun === 0) this.firstLoudFrame = idx;
        this.loudRun++;
        if (this.loudRun >= this.o.onFrames) {
          this.inSpeech = true; this.quietMs = 0; this.lastLoudEndMs = endMs;
          return { state: 'speech_start', detected_ms: endMs, acoustic_ms: this.firstLoudFrame * this.o.frameMs };
        }
      } else { this.loudRun = 0; this.firstLoudFrame = -1; }
      return null;
    }
    // in speech
    if (loud) { this.quietMs = 0; this.lastLoudEndMs = endMs; return null; }
    this.quietMs += this.o.frameMs;
    if (this.quietMs >= this.o.offHangoverMs) {
      this.inSpeech = false; this.loudRun = 0; this.firstLoudFrame = -1;
      return { state: 'speech_end', detected_ms: endMs, acoustic_ms: this.lastLoudEndMs };
    }
    return null;
  }
}
