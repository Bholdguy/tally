import { describe, expect, it } from 'vitest';
import { bytesToMs, concat, msToBytes, paceChunks, silence, wavToPcm, CHUNK_BYTES } from '../src/audio.js';
import { loadAgentConfig, Secret } from '../src/config.js';
import { normaliseWire } from '../src/wire.js';
import { errorResult, heldResult, okResult } from '../src/repair-adapter.js';
import { injectOrderId } from '../src/tools.js';
import { buildSystemPrompt, menuKeyterms } from '../src/prompt.js';

describe('Secret / config (SECURITY §2)', () => {
  it('never leaks through string, JSON or template interpolation', () => {
    const s = new Secret('super-secret-value-123');
    expect(`${s}`).toBe('[redacted]');
    expect(JSON.stringify({ k: s })).toBe('{"k":"[redacted]"}');
    expect(String(s)).not.toContain('super');
    expect(s.reveal()).toBe('super-secret-value-123');
  });
  it('refuses to load without a key', () => {
    expect(() => loadAgentConfig({} as NodeJS.ProcessEnv)).toThrow(/ASSEMBLYAI_API_KEY/);
    expect(() => loadAgentConfig({ ASSEMBLYAI_API_KEY: '   ' } as NodeJS.ProcessEnv)).toThrow();
  });
  it('defaults to the verified endpoint and serialises without the key', () => {
    const c = loadAgentConfig({ ASSEMBLYAI_API_KEY: 'abc-key-123456' } as NodeJS.ProcessEnv);
    expect(c.wsUrl).toBe('wss://agents.assemblyai.com/v1/ws');
    expect(JSON.stringify(c)).not.toContain('abc-key');
  });
});

describe('wire → event normalisation (tolerant, D-13)', () => {
  it('maps the documented user-turn events', () => {
    expect(normaliseWire({ type: 'input.speech.started' })).toEqual({ type: 'event', draft: { kind: 'input_speech_started' } });
    expect(normaliseWire({ type: 'transcript.user.delta', text: 'two bur' })).toMatchObject({ draft: { kind: 'transcript_user_delta', text: 'two bur' } });
    expect(normaliseWire({ type: 'transcript.user', text: 'two burgers', item_id: 'i1' })).toMatchObject({ draft: { kind: 'transcript_user', text: 'two burgers', item_id: 'i1' } });
  });
  it('carries no confidence field even if the API adds one (D-03: we do not rely on it)', () => {
    const n = normaliseWire({ type: 'transcript.user', text: 'x', confidence: 0.4 });
    expect(JSON.stringify(n)).not.toContain('confidence');
  });
  it('maps reply lifecycle, tolerating missing reply_id', () => {
    expect(normaliseWire({ type: 'reply.started' })).toMatchObject({ draft: { kind: 'reply_started' } });
    expect(normaliseWire({ type: 'reply.done', status: 'interrupted' })).toMatchObject({ draft: { kind: 'reply_done', status: 'interrupted' } });
    expect(normaliseWire({ type: 'transcript.agent', text: 'hi', interrupted: true, reply_id: 'r', item_id: 'i' })).toMatchObject({ draft: { kind: 'transcript_agent', interrupted: true } });
  });
  it('tool.call: object arguments, or a JSON string tolerated', () => {
    expect(normaliseWire({ type: 'tool.call', call_id: 'c1', name: 'add_item', arguments: { item_id: 'burger' } })).toMatchObject({ draft: { kind: 'tool_call', aai_call_id: 'c1', tool: 'add_item', args: { item_id: 'burger' } } });
    expect(normaliseWire({ type: 'tool.call', call_id: 'c1', name: 'add_item', arguments: '{"item_id":"burger"}' })).toMatchObject({ draft: { args: { item_id: 'burger' } } });
  });
  it('malformed input becomes a warning, never a throw', () => {
    for (const bad of [null, 42, {}, { type: 5 }, { type: 'tool.call' }, { type: 'reply.done', status: 'weird' }, { type: 'transcript.user' }, { type: 'tool.call', call_id: 'c', name: 'n', arguments: '{oops' }]) {
      expect(normaliseWire(bad as any).type, JSON.stringify(bad)).toBe('warning');
    }
  });
  it('audio and unknown types are ignored, not errors', () => {
    expect(normaliseWire({ type: 'reply.audio', data: 'AAAA' }).type).toBe('ignored');
    expect(normaliseWire({ type: 'something.new' }).type).toBe('ignored');
  });
  it('session.ready yields the session id', () => {
    expect(normaliseWire({ type: 'session.ready', session_id: 's-1' })).toEqual({ type: 'ready', session_id: 's-1' });
  });
});

describe('audio', () => {
  it('24 kHz PCM16: 48 bytes per ms, alignment preserved', () => {
    expect(msToBytes(1000)).toBe(48000);
    expect(bytesToMs(48000)).toBe(1000);
    expect(msToBytes(7.3) % 2).toBe(0);
    expect(silence(100).byteLength).toBe(4800);
  });
  function wav(pcm: Uint8Array, rate = 24000, extraChunk = false): Uint8Array {
    const hdr = new DataView(new ArrayBuffer(44));
    const w = (o: number, s: string) => [...s].forEach((c, i) => hdr.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); hdr.setUint32(4, 36 + pcm.byteLength, true); w(8, 'WAVE'); w(12, 'fmt ');
    hdr.setUint32(16, 16, true); hdr.setUint16(20, 1, true); hdr.setUint16(22, 1, true); hdr.setUint32(24, rate, true);
    hdr.setUint32(28, rate * 2, true); hdr.setUint16(32, 2, true); hdr.setUint16(34, 16, true); w(36, 'data'); hdr.setUint32(40, pcm.byteLength, true);
    const head = new Uint8Array(hdr.buffer);
    if (!extraChunk) return concat(head, pcm);
    const junk = new Uint8Array([...'LIST'].map((c) => c.charCodeAt(0)).concat([4, 0, 0, 0, 1, 2, 3, 4]));
    return concat(head.subarray(0, 36), junk, head.subarray(36), pcm);
  }
  it('wavToPcm extracts the data chunk (also past extra chunks) and rejects wrong formats', () => {
    const pcm = new Uint8Array([1, 2, 3, 4, 5, 6]);
    expect([...wavToPcm(wav(pcm))]).toEqual([...pcm]);
    expect([...wavToPcm(wav(pcm, 24000, true))]).toEqual([...pcm]);
    expect(() => wavToPcm(wav(pcm, 16000))).toThrow(/24kHz/);
    expect(() => wavToPcm(new Uint8Array(10))).toThrow();
  });
  it('paceChunks never sends faster than real time (API drops frames beyond ~1 s per second)', async () => {
    const pcm = new Uint8Array(msToBytes(600)); // 600 ms of audio = 30 chunks
    const stamps: number[] = [];
    const t0 = performance.now();
    await paceChunks(pcm, () => stamps.push(performance.now() - t0));
    expect(stamps).toHaveLength(30);
    expect(stamps[29]!).toBeGreaterThanOrEqual(29 * 20 - 8); // last chunk due at 29*20ms, small timer slack allowed
    expect(performance.now() - t0).toBeGreaterThanOrEqual(560);
    expect(CHUNK_BYTES).toBe(960);
  });
});

describe('RepairAdapter: instruction-only, encoded in the result JSON (D-09, D-13)', () => {
  it('HELD result tells the agent what to ask and forbids acting', () => {
    const r = JSON.parse(heldResult({ aai_call_id: 'c', code: 'QTY_MISMATCH', item_id: 'burger', evidenced_value: '3', ask_text: "Just to confirm, that's 3 classic burgers?", attempt: 1 }));
    expect(r.status).toBe('HELD');
    expect(r.code).toBe('QTY_MISMATCH');
    expect(r.instruction).toContain("Just to confirm, that's 3 classic burgers?");
    expect(r.instruction).toMatch(/Nothing was changed/);
  });
  it('OK and ERROR results carry a status field, never a bare success', () => {
    expect(JSON.parse(okResult({ lines: [{ item_id: 'burger', quantity: 3, modifiers: [] }], total_cents: 2697, status: 'open' }))).toMatchObject({ status: 'OK', total: '$26.97' });
    expect(JSON.parse(errorResult('NOT_IN_ORDER', 'x')).status).toBe('ERROR');
  });
});

describe('order_id injection (SECURITY §5)', () => {
  it('overwrites a model-supplied order_id for order-scoped tools and leaves others untouched', () => {
    expect(injectOrderId('confirm_order', { order_id: 'someone-else', pickup_time: 'ASAP' }, 'mine')).toEqual({ order_id: 'mine', pickup_time: 'ASAP' });
    expect(injectOrderId('get_order_state', undefined, 'mine')).toEqual({ order_id: 'mine' });
    expect(injectOrderId('add_item', { item_id: 'burger' }, 'mine')).toEqual({ item_id: 'burger' });
  });
});

describe('prompt', () => {
  it('lists every menu id and forbids acting on a HELD result', () => {
    const p = buildSystemPrompt();
    expect(p).toContain('veggie_burger');
    expect(p).toMatch(/HELD/);
    expect(menuKeyterms().length).toBeLessThanOrEqual(100);
  });
});
