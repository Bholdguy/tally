import { describe, expect, it } from 'vitest';
import type { SttRaw } from '../../stt/src/stream.js';
import { analyseSttRun, summarise } from '../src/spike/analyze-stt.js';
import type { RawLine } from '../src/spike/analyze.js';

// Synthetic lines exercise the analyzer's rules. They are NOT captured API data.
const P = (t: number, dir: 'in' | 'out', msg: any): RawLine => ({ dir, t_ms: t, wall_ms: t, audio_offset_ms: 0, msg });
const M = (t: number, label: string): RawLine => ({ dir: 'marker', t_ms: t, wall_ms: t, audio_offset_ms: 0, label });
const S = (t: number, transcript: string, eot: boolean, conf = 0.9): SttRaw => ({ dir: 'in', t_ms: t, wall_ms: t, audio_offset_ms: 0, msg: { type: 'Turn', turn_order: 0, end_of_turn: eot, transcript, words: [{ text: 'x', start: 0, end: 1, confidence: conf }] } });

const holdRun: RawLine[] = [
  M(5000, 'say:two_burgers'), M(6600, 'end:two_burgers'),
  P(9000, 'in', { type: 'tool.call', call_id: 'c1', name: 'add_item', arguments: { item_id: 'burger', quantity: 2, modifiers: [] } }),
  M(9050, 'correction:during_hold'), M(9050, 'say:no_wait_three'),
  M(11400, 'end:no_wait_three'),
  P(11500, 'out', { type: 'tool.result', call_id: 'c1', result: '{}' }),
];

describe('analyseSttRun', () => {
  it('correction spoken during a hold: independent stream delivers it; primary never did', () => {
    const stt = [S(6000, '2 burgers.', true), S(10200, 'No, wait,', false), S(11000, 'No, wait, make it 3.', false), S(12300, 'No, wait, make it 3.', true, 0.71)];
    const r = analyseSttRun('correction_during_hold', holdRun, stt);
    const c = r.corrections[0]!;
    expect(c.primary_delivered).toBe(false);
    expect(c.stt_delivered).toBe(true);
    expect(c.stt_first_ms).toBe(11000);
    expect(c.stt_final_ms).toBe(12300);
    expect(c.first_after_call_ms).toBe(2000);     // partial evidence 2.0 s after tool.call
    expect(c.final_after_call_ms).toBe(3300);
    expect(c.final_lag_after_speech_end_ms).toBe(900);
    expect(c.stt_turns_during_hold).toBe(2);      // 10200 and 11000 arrived while the hold was open (9000..11500)
    expect(c.stt_has_cue).toBe(true);
    expect(c.stt_min_word_conf).toBe(0.71);
    expect(c.call_qty).toBe(2);
  });
  it('reports "never" when the independent stream misses the correction (gap NOT closed)', () => {
    const r = analyseSttRun('x', holdRun, [S(6000, '2 burgers.', true)]);
    expect(r.corrections[0]!.stt_delivered).toBe(false);
    expect(r.corrections[0]!.stt_final_ms).toBeNull();
  });
  it('an ordinary utterance does not count as a correction', () => {
    const r = analyseSttRun('x', holdRun, [S(6000, 'Two burgers and a coke.', true)]);
    expect(r.corrections[0]!.stt_delivered).toBe(false);
  });
  it('detects primary live delivery (correction text + cue in transcript.user)', () => {
    const lines = [...holdRun, P(12000, 'in', { type: 'transcript.user', text: 'No, wait, make it 3.' })];
    expect(analyseSttRun('x', lines, []).corrections[0]!.primary_delivered).toBe(true);
  });
  it('first-utterance latency cost: is the stt final ready before the primary tool.call?', () => {
    expect(analyseSttRun('x', holdRun, [S(8000, '2 burgers.', true)]).first_utterance_final_before_call).toBe(true);
    expect(analyseSttRun('x', holdRun, [S(9500, '2 burgers.', true)]).first_utterance_final_before_call).toBe(false);
  });
});

describe('summarise', () => {
  it('aggregates delivery, waits and lag across runs', () => {
    const a = analyseSttRun('s', holdRun, [S(11000, 'No, wait, make it 3.', false), S(12300, 'No, wait, make it 3.', true)]);
    const b = analyseSttRun('s', holdRun, []);
    const [sum] = summarise([a, b]);
    expect(sum).toMatchObject({ scenario: 's', runs: 2, corrections: 2, stt_delivered: 1, stt_final_delivered: 1, primary_delivered: 0, wait_first_p50: 2000, wait_final_max: 3300 });
  });
});
