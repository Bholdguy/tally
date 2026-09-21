import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PCM_BYTES_PER_MS, PcmRecorder, readPcm } from '../src/recorder.js';

const dir = () => mkdtempSync(join(tmpdir(), 'tally-rec-'));
const chunk = (n: number, fill: number) => new Uint8Array(n).fill(fill);

describe('PcmRecorder', () => {
  it('records exactly the bytes appended, in order, and reports duration at 48 bytes/ms', () => {
    const r = new PcmRecorder(dir(), 's1');
    r.append(chunk(960, 1)); r.append(chunk(960, 2)); r.append(chunk(480, 3));
    const out = r.close();
    expect(out.bytes).toBe(2400);
    expect(out.duration_ms).toBe(2400 / PCM_BYTES_PER_MS);
    const back = readPcm(out.pointer);
    expect(back.byteLength).toBe(2400);
    expect([back[0], back[959], back[960], back[1919], back[1920], back[2399]]).toEqual([1, 1, 2, 2, 3, 3]);
  });
  it('the sha256 in the receipt matches the file on disk', () => {
    const r = new PcmRecorder(dir(), 's2');
    r.append(chunk(1000, 7));
    const out = r.close();
    expect(out.sha256).toBe(createHash('sha256').update(readFileSync(out.pointer)).digest('hex'));
  });
  it('is on disk immediately (synchronous writes): a crash before close() loses nothing already appended', () => {
    const r = new PcmRecorder(dir(), 's3');
    r.append(chunk(960, 9));
    expect(statSync(r.pointer).size).toBe(960);
  });
  it('refuses to append after close, and close() is idempotent', () => {
    const r = new PcmRecorder(dir(), 's4');
    r.append(chunk(10, 1));
    const a = r.close();
    expect(() => r.append(chunk(10, 1))).toThrow(/closed/);
    expect(r.close()).toEqual(a);
  });
  it('never overwrites an existing recording', () => {
    const d = dir();
    new PcmRecorder(d, 's5').close();
    expect(() => new PcmRecorder(d, 's5')).toThrow();
  });
  it('two sessions get distinct files; unsafe session ids cannot escape the directory', () => {
    const d = dir();
    const a = new PcmRecorder(d, 'a'); const b = new PcmRecorder(d, '../../etc/passwd');
    expect(a.pointer).not.toBe(b.pointer);
    expect(b.pointer.startsWith(d)).toBe(true);
    expect(existsSync(b.pointer)).toBe(true);
    a.close(); b.close();
  });
  it('handles a large stream (a 60 s call = 2.88 MB) and matches the sent byte count exactly', () => {
    const r = new PcmRecorder(dir(), 's6');
    for (let i = 0; i < 3000; i++) r.append(chunk(960, i & 255)); // 60 s of 20 ms chunks
    const out = r.close();
    expect(out.bytes).toBe(2_880_000);
    expect(out.duration_ms).toBe(60000);
    expect(statSync(out.pointer).size).toBe(2_880_000);
  });
});
