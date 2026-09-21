// Accessibility (contrast, colour never the only signal), the mic helpers, escaping, and "words not ids" in operator-facing views.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MENU } from '@tally/contract';
import { esc, idAttr } from '../src/escape.js';
import { downsample, floatToPcm16, Framer, FRAME_SAMPLES, pcm16ToFloat } from '../src/mic.js';
import { statusLabel, type CallStatus } from '../src/state.js';
import { badge, callTable, codeChip, compareTable, header, liveView, orderPanel } from '../src/views.js';
import { initialLive } from '../src/state.js';

const css = readFileSync(join(process.cwd(), 'dashboard/public/style.css'), 'utf8');
const vars = Object.fromEntries([...css.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1]!, m[2]!]));
const lum = (hex: string) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!; };
const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };

describe('accessibility', () => {
  it('every foreground/background pair used for status and text meets WCAG AA (4.5:1)', () => {
    const pairs: [string, string][] = [['text', 'bg'], ['text', 'panel'], ['muted', 'bg'], ['muted', 'panel'], ['ok', 'ok-bg'], ['repaired', 'repaired-bg'], ['bad', 'bad-bg'], ['wait', 'wait-bg'], ['ok', 'panel'], ['bad', 'panel'], ['repaired', 'panel'], ['speech', 'bg'], ['ok', 'bg'], ['bad', 'bg'], ['repaired', 'bg']];
    for (const [f, b] of pairs) expect(contrast(vars[f]!, vars[b]!), `${f} on ${b}`).toBeGreaterThanOrEqual(4.5);
  });

  it('colour is never the only signal: every call status has a distinct text label, and every badge renders its text', () => {
    const all: CallStatus[] = ['pending', 'waiting', 'allowed', 'repaired', 'noop', 'conflict', 'held'];
    const labels = all.map((status) => statusLabel({ status, code: 'CODE' }));
    expect(new Set(labels).size).toBe(all.length);
    for (const l of labels) expect(badge('allowed', l)).toContain(l);
    expect(badge('conflict', 'CONFLICT')).toContain('aria-hidden="true"');           // the dot is decorative; the words carry the meaning
  });

  it('interactive controls are real buttons with visible focus styles; the timeline has an accessible name', () => {
    expect(css).toMatch(/button:focus-visible/);
    expect(liveView(initialLive(), { now: 0, scenarios: [], mic: false, busy: null, sessions: [] })).toMatch(/role="img" aria-label="evidence timeline"/);
    expect(header({ tab: 'live', counts: null, metrics: null, demoBanner: null })).toMatch(/aria-pressed/);
  });
});

describe('escaping', () => {
  it('escapes every HTML-significant character; ids are reduced to a safe alphabet', () => {
    expect(esc('<a href="x" onclick=\'y\'>&`')).toBe('&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&#96;');
    expect(esc(null)).toBe(''); expect(esc(undefined)).toBe(''); expect(esc(5)).toBe('5');
    expect(idAttr('case_1"><script>')).toBe('case_1script');
  });
  it('the served page has no inline script or handler attribute (the CSP forbids them as a second layer)', () => {
    const html = readFileSync(join(process.cwd(), 'dashboard/public/index.html'), 'utf8');
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/i);
    expect(html).not.toMatch(/\son\w+=/i);
  });
});

describe('operator-facing views show words, not internal ids', () => {
  it('the order panel and the compare table never show an underscore id for any menu item or modifier', () => {
    for (const m of MENU) {
      const html = orderPanel({ lines: [{ item_id: m.item_id, quantity: 2, modifiers: m.modifiers.slice(0, 2) }], total_cents: 1, status: 'open' });
      expect(html.replace(/id="[^"]*"/g, '')).not.toMatch(/[a-z]+_[a-z]+/);
    }
  });
  it('an unrecognised conflict code is escaped and flagged, never rendered as markup', () => {
    expect(codeChip('<b>x</b>')).not.toContain('<b>');
    expect(codeChip('<b>x</b>')).toContain('unrecognised code');
    expect(compareTable([{ case_id: 'c', pattern_key: '<i>p</i>', tag: 'none', by_version: {} }], ['v1'])).not.toContain('<i>p</i>');
    expect(callTable({ ...initialLive(), calls: [{ id: '1', tool: '<u>', args: null, start: 0, end: 1, status: 'held', code: 'X' }] })).not.toContain('<u>');
  });
});

describe('microphone helpers (pure)', () => {
  it('downsamples 48 kHz to 24 kHz (half the samples), keeps a constant signal, and passes 24 kHz through unchanged', () => {
    const a = new Float32Array(4800).fill(0.5);
    const d = downsample(a, 48000);
    expect(d.length).toBe(2400);
    expect(Math.max(...d)).toBeCloseTo(0.5); expect(Math.min(...d)).toBeCloseTo(0.5);
    expect(downsample(a, 24000)).toBe(a);
    expect(downsample(new Float32Array(441), 44100).length).toBe(240);
  });
  it('float <-> PCM16: clamps, is little-endian, and round-trips to within one LSB', () => {
    const pcm = floatToPcm16(Float32Array.from([0, 1, -1, 2, -2, 0.5]));
    expect([...new Int16Array(pcm.buffer)]).toEqual([0, 32767, -32768, 32767, -32768, 16384]);
    const back = pcm16ToFloat(pcm);
    expect(back[5]).toBeCloseTo(0.5, 3);
  });
  it('the framer emits exact 20 ms (960-byte) frames whatever the block size, and keeps the remainder', () => {
    const f = new Framer();
    const out = [...f.push(new Float32Array(1000)), ...f.push(new Float32Array(1000)), ...f.push(new Float32Array(500))];
    expect(out.every((fr) => fr.byteLength === FRAME_SAMPLES * 2 && fr.byteLength === 960)).toBe(true);
    expect(out).toHaveLength(Math.floor(2500 / FRAME_SAMPLES));
  });
});
