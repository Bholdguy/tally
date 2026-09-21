import { describe, expect, it } from 'vitest';
import { WireEventStream, AUDIBLE_RMS } from '../src/wire-events.js';

const s16 = (amp: number, n = 480) => { const b = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * Math.sin(i / 5)), i * 2); return b.toString('base64'); };
const mk = () => new WireEventStream({ mode: 'live', config_version: 'v1' });

describe('WireEventStream', () => {
  it('carries the SERVER timestamp (epoch seconds -> ms) on every mapped event (spike finding F9)', () => {
    const w = mk();
    const out = w.process({ type: 'input.speech.started', timestamp: 1789857214.4053676 });
    expect(out.drafts[0]).toMatchObject({ kind: 'input_speech_started', server_ts_ms: 1789857214405 });
    expect(w.process({ type: 'input.speech.started' }).drafts[0]).not.toHaveProperty('server_ts_ms');
  });
  it('session.ready becomes session_started and reports the session id', () => {
    const out = mk().process({ type: 'session.ready', session_id: 'sess_1', timestamp: 5 });
    expect(out.ready).toEqual({ session_id: 'sess_1' });
    expect(out.drafts[0]).toMatchObject({ kind: 'session_started', mode: 'live', config_version: 'v1', server_ts_ms: 5000 });
  });
  it('reply_audible fires ONCE per reply, on the first non-silent chunk; silence padding never does (D-18)', () => {
    const w = mk();
    w.process({ type: 'reply.started', reply_id: 'r1' });
    expect(w.process({ type: 'reply.audio', data: s16(0) }).drafts).toEqual([]);
    expect(w.process({ type: 'reply.audio', data: s16(0) }).drafts).toEqual([]);
    expect(w.process({ type: 'reply.audio', data: s16(6000) }).drafts).toEqual([expect.objectContaining({ kind: 'reply_audible', reply_id: 'r1' })]);
    expect(w.process({ type: 'reply.audio', data: s16(6000) }).drafts).toEqual([]);
  });
  it('a new reply resets audibility', () => {
    const w = mk();
    w.process({ type: 'reply.started', reply_id: 'r1' });
    expect(w.process({ type: 'reply.audio', data: s16(6000) }).drafts).toHaveLength(1);
    w.process({ type: 'reply.done', status: 'completed' });
    w.process({ type: 'reply.started', reply_id: 'r2' });
    expect(w.process({ type: 'reply.audio', data: s16(0) }).drafts).toEqual([]);
    expect(w.process({ type: 'reply.audio', data: s16(6000) }).drafts).toEqual([expect.objectContaining({ reply_id: 'r2' })]);
  });
  it('reads captured logs, where the payload was replaced by a byte count and an RMS', () => {
    const w = mk();
    w.process({ type: 'reply.started' });
    expect(w.process({ type: 'reply.audio', data: '<480 bytes>', rms: 0 }).drafts).toEqual([]);
    expect(w.process({ type: 'reply.audio', data: '<480 bytes>', rms: AUDIBLE_RMS + 1 }).drafts).toHaveLength(1);
  });
  it('returns the decoded audio for playback', () => {
    expect(mk().process({ type: 'reply.audio', data: s16(1000, 10) }).audio?.byteLength).toBe(20);
  });
  it('malformed input yields a parse_warning draft, never a throw', () => {
    expect(mk().process({ type: 'tool.call' }).drafts[0]).toMatchObject({ kind: 'parse_warning' });
  });
});
