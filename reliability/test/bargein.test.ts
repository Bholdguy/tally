import { existsSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { TallyEvent } from '@tally/contract';
import { agentEventsFromCapture } from '../../scripts/lib/wire-replay.js';
import { BargeInDeriver } from '../src/bargein.js';

let n = 0;
const ev = (t: number, e: Record<string, unknown>) => ({ id: `e${++n}`, session_id: 's', t_ms: t, wall_ms: 0, audio_offset_ms: 0, ...e }) as TallyEvent;
const run = (events: TallyEvent[]) => { const d = new BargeInDeriver(); return events.flatMap((e) => { const r = d.ingest(e); return r ? [r] : []; }); };

describe('BargeInDeriver (synthetic sequences)', () => {
  it('speech over AUDIBLE agent speech, then reply_done(interrupted): one barge-in with both source ids and a reaction time', () => {
    const start = ev(100, { kind: 'reply_started' });
    const speech = ev(1000, { kind: 'input_speech_started' });
    const done = ev(1004, { kind: 'reply_done', status: 'interrupted' });
    const out = run([start, ev(200, { kind: 'reply_audible' }), ev(999, { kind: 'transcript_agent', text: 'hi', interrupted: true }), speech, done]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'barge_in', derived: true, source_event_ids: [speech.id, done.id], reaction_ms: 4 });
  });
  it('the order transcript_agent(interrupted) BEFORE speech_started does not matter (spike-observed wire order)', () => {
    expect(run([ev(0, { kind: 'reply_started' }), ev(1, { kind: 'reply_audible' }), ev(5, { kind: 'transcript_agent', text: 'x', interrupted: true }), ev(5, { kind: 'input_speech_started' }), ev(5, { kind: 'reply_done', status: 'interrupted' })])).toHaveLength(1);
  });
  it('speech over hold-mode SILENCE padding (never audible) is not a barge-in', () => {
    expect(run([ev(0, { kind: 'reply_started' }), ev(10, { kind: 'input_speech_started' }), ev(20, { kind: 'reply_done', status: 'interrupted' })])).toEqual([]);
  });
  it('backchannel: speech over an audible reply that COMPLETES is not a barge-in', () => {
    expect(run([ev(0, { kind: 'reply_started' }), ev(1, { kind: 'reply_audible' }), ev(10, { kind: 'input_speech_started' }), ev(30, { kind: 'reply_done', status: 'completed' })])).toEqual([]);
  });
  it('an interrupted reply with no user speech to attribute it to yields nothing (conservative)', () => {
    expect(run([ev(0, { kind: 'reply_started' }), ev(1, { kind: 'reply_audible' }), ev(30, { kind: 'reply_done', status: 'interrupted' })])).toEqual([]);
  });
  it('state resets between replies: a stale speech marker from reply 1 cannot interrupt reply 2', () => {
    const out = run([ev(0, { kind: 'reply_started' }), ev(1, { kind: 'reply_audible' }), ev(2, { kind: 'input_speech_started' }), ev(3, { kind: 'reply_done', status: 'completed' }), ev(10, { kind: 'reply_started' }), ev(11, { kind: 'reply_audible' }), ev(12, { kind: 'reply_done', status: 'interrupted' })]);
    expect(out).toEqual([]);
  });
  it('uses the SERVER timestamps for the reaction time when both events carry them (D-05)', () => {
    const out = run([ev(0, { kind: 'reply_started' }), ev(1, { kind: 'reply_audible' }), ev(500, { kind: 'input_speech_started', server_ts_ms: 1_000_000 }), ev(560, { kind: 'reply_done', status: 'interrupted', server_ts_ms: 1_000_012 })]);
    expect(out[0]).toMatchObject({ reaction_ms: 12 });
  });
  it('two separate interruptions produce two markers', () => {
    const seq = (o: number) => [ev(o, { kind: 'reply_started' }), ev(o + 1, { kind: 'reply_audible' }), ev(o + 2, { kind: 'input_speech_started' }), ev(o + 3, { kind: 'reply_done', status: 'interrupted' })];
    expect(run([...seq(0), ...seq(100)])).toHaveLength(2);
  });
});

const D = 'fixtures/aai-events';
const have = existsSync(`${D}/barge_in_speech-1.jsonl`);
describe.skipIf(!have)('BargeInDeriver on REAL captures (same WireEventStream as live)', () => {
  it('real interruption over audible agent speech is derived exactly once, with a millisecond-scale reaction (barge_in_speech x2)', () => {
    for (const f of ['barge_in_speech-1', 'barge_in_speech-2']) {
      const out = run(agentEventsFromCapture(`${D}/${f}.jsonl`));
      expect(out, f).toHaveLength(1);
      expect(out[0]!.reaction_ms!, f).toBeLessThan(50);
    }
  });
  it('real backchannel over audible speech is NOT a barge-in (backchannel_speech x2)', () => {
    for (const f of ['backchannel_speech-1', 'backchannel_speech-2']) expect(run(agentEventsFromCapture(`${D}/${f}.jsonl`)), f).toEqual([]);
  });
  it('user speech over hold-mode silence padding is NOT a barge-in (silent-reply barge captures, clean, late and hold captures)', () => {
    const dirs = ['fixtures/aai-events/run2-silent-barge', 'fixtures/aai-events-A-hold'];
    let checked = 0;
    for (const dir of dirs) for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl') && !x.endsWith('.stt.jsonl'))) {
      expect(run(agentEventsFromCapture(`${dir}/${f}`)), `${dir}/${f}`).toEqual([]);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(25);
  });
  it('across every valid top-level capture the derivation finds exactly the 2 real interruptions', () => {
    const files = readdirSync(D).filter((x) => x.endsWith('.jsonl'));
    const total = files.reduce((s, f) => s + run(agentEventsFromCapture(`${D}/${f}`)).length, 0);
    expect(total).toBe(2);
  });
});
