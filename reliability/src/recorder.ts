// Raw input-audio recorder (Step 4, `sessions.audio_pointer`). Records the SAME PCM16 mono 24 kHz chunks that are sent to
// the agent, byte for byte, so a case can later be replayed (D-07) and every event's audio_offset_ms points at real bytes
// (provenance, rule 2). Input audio only: Tally has no path to voice OUTPUT. Synchronous writes so nothing is lost on a crash.
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const PCM_BYTES_PER_MS = 48; // 24 kHz * 2 bytes / 1000

export interface RecordedAudio { pointer: string; bytes: number; duration_ms: number; sha256: string }

export class PcmRecorder {
  private fd: number | null;
  private bytes = 0;
  private readonly hash = createHash('sha256');
  readonly pointer: string;

  constructor(dir: string, sessionId: string) {
    mkdirSync(dir, { recursive: true });
    this.pointer = join(dir, `${sessionId.replace(/[^A-Za-z0-9_.-]/g, '_')}.pcm`);
    this.fd = openSync(this.pointer, 'wx'); // 'wx': never overwrite an existing recording (evidence is append-only in spirit)
  }

  get bytesWritten(): number { return this.bytes; }
  get durationMs(): number { return this.bytes / PCM_BYTES_PER_MS; }

  append(pcm: Uint8Array): void {
    if (this.fd === null) throw new Error('recorder is closed');
    let off = 0;
    while (off < pcm.byteLength) off += writeSync(this.fd, pcm, off, pcm.byteLength - off);
    this.hash.update(pcm);
    this.bytes += pcm.byteLength;
  }

  close(): RecordedAudio {
    if (this.fd !== null) { closeSync(this.fd); this.fd = null; }
    return { pointer: this.pointer, bytes: this.bytes, duration_ms: this.durationMs, sha256: this.hash.copy().digest('hex') };
  }
}

/** Load a recording for replay. */
export function readPcm(pointer: string): Uint8Array {
  return new Uint8Array(readFileSync(pointer));
}
