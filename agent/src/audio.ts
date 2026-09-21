// Audio helpers. Voice Agent input: base64 PCM16 mono 24 kHz, sent at real time (frames beyond ~1 s/s are dropped).
export const SAMPLE_RATE = 24000;
export const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000; // 48
export const CHUNK_MS = 20;
export const CHUNK_BYTES = CHUNK_MS * BYTES_PER_MS; // 960

export const bytesToMs = (bytes: number): number => bytes / BYTES_PER_MS;
export const msToBytes = (ms: number): number => Math.round(ms * BYTES_PER_MS) & ~1; // keep sample alignment

export function silence(ms: number): Uint8Array {
  return new Uint8Array(msToBytes(ms));
}

/** Strip a canonical 44-byte RIFF/WAVE header (PCM16 mono 24 kHz expected; validated). */
export function wavToPcm(wav: Uint8Array): Uint8Array {
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (o: number) => String.fromCharCode(...wav.subarray(o, o + 4));
  if (wav.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  const channels = dv.getUint16(22, true);
  const rate = dv.getUint32(24, true);
  const bits = dv.getUint16(34, true);
  if (channels !== 1 || rate !== SAMPLE_RATE || bits !== 16) throw new Error(`wav must be 24kHz mono 16-bit, got ${rate}Hz ${channels}ch ${bits}bit`);
  // find the 'data' chunk (header may carry extra chunks)
  let o = 12;
  while (o + 8 <= wav.byteLength) {
    const id = tag(o);
    const size = dv.getUint32(o + 4, true);
    if (id === 'data') return wav.subarray(o + 8, Math.min(wav.byteLength, o + 8 + size));
    o += 8 + size + (size & 1);
  }
  throw new Error('wav has no data chunk');
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}

/**
 * Real-time pacer: emits CHUNK_MS chunks no faster than wall-clock. Uses an absolute schedule (start + n*20ms)
 * so timer jitter never accumulates into "faster than real time" bursts.
 */
export async function paceChunks(pcm: Uint8Array, send: (chunk: Uint8Array) => void, opts: { signal?: AbortSignal } = {}): Promise<void> {
  const start = performance.now();
  let n = 0;
  for (let o = 0; o < pcm.byteLength; o += CHUNK_BYTES, n++) {
    if (opts.signal?.aborted) return;
    const due = start + n * CHUNK_MS;
    const wait = due - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    send(pcm.subarray(o, Math.min(o + CHUNK_BYTES, pcm.byteLength)));
  }
}
