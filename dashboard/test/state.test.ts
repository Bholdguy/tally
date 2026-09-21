// The live view's reducer, over the REAL event streams captured from the deterministic demo pipeline (dashboard/test/fixtures).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { initialLive, reduce, reduceAll, statusLabel, statusOf, type Ev } from '../src/state.js';
import { layout, renderSvg } from '../src/timeline.js';

const load = (n: string): Ev[] => JSON.parse(readFileSync(new URL(`./fixtures/${n}.events.json`, import.meta.url), 'utf8'));

describe('reducer: scenario B (interrupt, gate waits, hold, repair, allow)', () => {
  const s = reduceAll(load('B'));

  it('tool calls carry the right status, in order: CONFLICT (red) then ALLOWED·REPAIRED (yellow)', () => {
    expect(s.calls.map((c) => c.status)).toEqual(['conflict', 'repaired']);
    expect(s.calls.map((c) => statusLabel(c))).toEqual(['CONFLICT QTY_MISMATCH', 'ALLOWED · REPAIRED']);
    expect(s.calls[0]!.waited_ms).toBeGreaterThan(1000);                         // the gate visibly waited
  });

  it('the derived barge-in is a marker with BOTH source event ids, and the agent segment is marked interrupted', () => {
    expect(s.bargeIns).toHaveLength(1);
    expect(s.bargeIns[0]!.ids).toHaveLength(2);
    expect(s.agent.some((a) => a.interrupted)).toBe(true);
  });

  it('the call log has the REPAIR line and the waiting line; the order panel shows the committed order and total', () => {
    expect(s.log.some((l) => l.kind === 'verdict' && l.status === 'waiting')).toBe(true);
    expect(s.log.find((l) => l.kind === 'repair')!.text).toBe('REPAIR: "Just to confirm, that\'s 3 classic burgers?"');
    expect(s.log.some((l) => l.kind === 'case')).toBe(true);
    expect(s.order).toMatchObject({ total_cents: 2697, lines: [{ item_id: 'burger', quantity: 3 }] });
    expect(s.cases).toBe(1);
    expect(s.ended).toBe(true);
    expect(s.waiting).toBeNull();
  });

  it('transcripts: the independent stream (evidence) and the agent stream are kept apart; partials are replaced by finals', () => {
    expect(s.transcripts.independent.map((l) => l.text)).toEqual(['Two burgers.', 'No, wait, make it three.', 'Yes, three.']);
    expect(s.transcripts.independent.every((l) => l.final)).toBe(true);
    expect(s.transcripts.agent.map((l) => l.text)).toContain("Just to confirm, that's 3 classic burgers?");
  });

  it('WAITING state is live while the gate waits (mid-stream), cleared by the verdict', () => {
    const evs = load('B');
    const at = evs.findIndex((e) => e.kind === 'gate_waiting');
    const mid = reduceAll(evs.slice(0, at + 1));
    expect(mid.waiting).toMatchObject({ tool: 'add_item', max_ms: 4000 });
    expect(mid.calls.at(-1)!.status).toBe('waiting');
    expect(reduceAll(evs.slice(0, evs.findIndex((e) => e.kind === 'verdict') + 1)).waiting).toBeNull();
  });
});

describe('reducer: A, dropout, confidence', () => {
  it('A: three green calls, order $20.47 confirmed, no cases, no barge-in', () => {
    const s = reduceAll(load('A'));
    expect(s.calls.map((c) => c.status)).toEqual(['allowed', 'allowed', 'allowed']);
    expect(s.order).toMatchObject({ total_cents: 2047, status: 'confirmed' });
    expect(s.cases).toBe(0);
    expect(s.bargeIns).toEqual([]);
  });

  it('dropout: the stream goes down, the call is HELD (UNVALIDATABLE), nothing on the order; the log says so', () => {
    const s = reduceAll(load('dropout'));
    expect(s.stream.status).toBe('down');
    expect(s.calls.map((c) => c.status)).toEqual(['held']);
    expect(statusLabel(s.calls[0]!)).toBe('HELD UNVALIDATABLE');
    expect(s.order!.lines).toEqual([]);
    expect(s.log.some((l) => /independent evidence stream DOWN/.test(l.text))).toBe(true);
  });

  it('confidence: the low-confidence transcript is flagged; hold then repaired allow', () => {
    const s = reduceAll(load('confidence'));
    expect(s.transcripts.independent[0]!.low).toBe(true);
    expect(s.calls.map((c) => c.status)).toEqual(['held', 'repaired']);
  });
});

describe('reducer properties', () => {
  it('pure: the same events give the same state, and the input state is never mutated', () => {
    const evs = load('B');
    const a = reduceAll(evs); const b = reduceAll(evs);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const s0 = initialLive(); const frozen = JSON.stringify(s0);
    reduce(s0, evs[0]!); reduce(s0, evs[5]!);
    expect(JSON.stringify(s0)).toBe(frozen);
  });

  it('unknown event kinds are ignored; a verdict for a call it never saw still renders', () => {
    const s = reduce(reduce(initialLive(), { id: 'x', session_id: 's', kind: 'something_new', t_ms: 5, wall_ms: 5 }), { id: 'v', session_id: 's', kind: 'verdict', t_ms: 9, wall_ms: 9, aai_call_id: 'c1', tool: 'add_item', args: { item_id: 'coke', quantity: 1 }, verdict: 'ALLOW' });
    expect(s.calls).toEqual([expect.objectContaining({ id: 'c1', status: 'allowed' })]);
  });

  it('status mapping: every verdict has a distinct label (colour is never the only signal)', () => {
    const cases = [statusOf('ALLOW', {}), statusOf('ALLOW', { repaired: true }), statusOf('ALLOW', { noop: true }), statusOf('HOLD', { code: 'QTY_MISMATCH' }), statusOf('HOLD', { code: 'UNVALIDATABLE' }), 'waiting' as const, 'pending' as const];
    const labels = cases.map((status) => statusLabel({ status, code: 'X' }));
    expect(new Set(labels).size).toBe(labels.length);
    for (const l of labels) expect(l.length).toBeGreaterThan(3);
  });
});

describe('timeline geometry (pure)', () => {
  const s = reduceAll(load('B'));
  const l = layout(s, 900);

  it('one shape per call in lane 3, each with a text label and a class; x is monotonic with time; shapes stay inside the canvas', () => {
    const calls = l.shapes.filter((x) => x.lane === 2);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.cls)).toEqual(['bad', 'repaired']);
    expect(calls.every((c) => c.label.length > 0)).toBe(true);
    expect(calls[0]!.x).toBeLessThan(calls[1]!.x);
    for (const sh of l.shapes) { expect(sh.x).toBeGreaterThanOrEqual(0); expect(sh.x + sh.w).toBeLessThanOrEqual(l.width + 1); expect(sh.w).toBeGreaterThanOrEqual(3); }
  });

  it('the barge-in is a diamond at the right x with both source ids in its tooltip; independent-stream ticks exist', () => {
    expect(l.diamonds).toHaveLength(1);
    expect(l.diamonds[0]!.title).toMatch(/barge-in \(derived\) · source events .+ \+ .+/);
    expect(l.ticks.length).toBeGreaterThan(0);
  });

  it('SVG is well-formed, has tooltips, and escapes hostile text', () => {
    const svg = renderSvg(l);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('<title>');
    const hostile = renderSvg(layout(reduce(initialLive(), { id: 'v', session_id: 's', kind: 'verdict', t_ms: 100, wall_ms: 0, aai_call_id: '<b>', tool: '<script>alert(1)</script>', verdict: 'HOLD', code: '"><img src=x>' }), 900));
    expect(hostile).not.toMatch(/<script|<img/i);
  });
});
