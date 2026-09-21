import { describe, expect, it } from 'vitest';
import { analyseRun, judge, type RawLine } from '../src/spike/analyze.js';

// Synthetic raw lines exercise the analyzer's rules. They are NOT captured API data.
const inn = (t: number, msg: any): RawLine => ({ dir: 'in', t_ms: t, wall_ms: t, audio_offset_ms: 0, msg });
const out = (t: number, msg: any): RawLine => ({ dir: 'out', t_ms: t, wall_ms: t, audio_offset_ms: 0, msg });
const marker = (t: number, label: string): RawLine => ({ dir: 'marker', t_ms: t, wall_ms: t, audio_offset_ms: 0, label });

const cleanHold: RawLine[] = [
  inn(1000, { type: 'input.speech.started' }), inn(1100, { type: 'transcript.user.delta', text: 'two' }),
  inn(2000, { type: 'input.speech.stopped' }), inn(2100, { type: 'transcript.user', text: 'Two burgers.' }),
  inn(2400, { type: 'tool.call', call_id: 'c1', name: 'add_item', arguments: {} }),
  out(2450, { type: 'tool.result', call_id: 'c1', result: '{}' }),
  inn(2900, { type: 'reply.started' }), inn(2950, { type: 'reply.audio', data: 'x' }), inn(2960, { type: 'reply.audio', data: 'x' }),
  inn(4000, { type: 'reply.done', status: 'completed' }),
];

describe('analyseRun', () => {
  it('extracts hold, final-before-call and silence metrics', () => {
    const r = analyseRun('clean', cleanHold);
    const c = r.calls[0]!;
    expect(c).toMatchObject({ tool: 'add_item', mutating: true, hold_ms: 50, final_before_call: true, spoke_before_call: false, stopped_to_call_ms: 400 });
    expect(c.pause_after_result_ms).toBe(500);
    expect(c.silence_total_ms).toBe(950); // speech stop 2000 → first agent audio 2950
    expect(r.ordering_signature).toContain('reply.audio*');
  });
  it('flags an agent that speaks before the tool call', () => {
    const lines = cleanHold.filter((l) => !(l.dir === 'in' && (l.msg as any).type === 'reply.started'));
    lines.splice(4, 0, inn(2200, { type: 'reply.started' }), inn(2210, { type: 'reply.audio', data: 'x', rms: 1800 }));
    expect(analyseRun('x', lines).calls[0]!.spoke_before_call).toBe(true);
  });
  it('distinguishes an interrupt from a backchannel (D-02 derivation inputs)', () => {
    const base = [inn(100, { type: 'reply.started' }), inn(150, { type: 'reply.audio', data: 'x', rms: 2000 }), inn(300, { type: 'input.speech.started' })];
    const intr = analyseRun('i', [...base, inn(380, { type: 'reply.done', status: 'interrupted' })]);
    expect(intr.barge).toEqual([expect.objectContaining({ kind: 'interrupt', reaction_ms: 80 })]);
    const back = analyseRun('b', [...base, inn(900, { type: 'reply.done', status: 'completed' })]);
    expect(back.barge).toEqual([expect.objectContaining({ kind: 'backchannel', reaction_ms: null })]);
  });
  it('user speech over a SILENT (padding-only) reply is not a barge-in or backchannel', () => {
    const r = analyseRun('s', [inn(100, { type: 'reply.started' }), inn(150, { type: 'reply.audio', data: 'x', rms: 0 }), inn(300, { type: 'input.speech.started' }), inn(900, { type: 'reply.done', status: 'completed' })]);
    expect(r.barge).toEqual([]);
  });
  it('ignores speech that begins after the reply already finished', () => {
    const r = analyseRun('n', [inn(100, { type: 'reply.started' }), inn(200, { type: 'reply.done', status: 'completed' }), inn(300, { type: 'input.speech.started' })]);
    expect(r.barge).toEqual([]);
  });
});

describe('judge (D-16 rules)', () => {
  it('INCONCLUSIVE with no mutating calls (never a silent pass)', () => {
    expect(judge([analyseRun('e', [])]).verdict).toBe('INCONCLUSIVE');
  });
  it('PASS when the agent is silent and no correction is blind', () => {
    const lines = [...cleanHold, marker(5000, 'correction:x'), inn(5100, { type: 'input.speech.started' })];
    expect(judge([analyseRun('clean', lines)]).verdict).toBe('PASS');
  });
  it('FAIL when the agent speaks before the tool call (hold premise broken)', () => {
    const lines = [...cleanHold];
    lines.splice(4, 0, inn(2200, { type: 'reply.started' }), inn(2210, { type: 'reply.audio', data: 'x', rms: 1800 }));
    const rep = judge([analyseRun('x', lines)]);
    expect(rep.verdict).toBe('FAIL');
    expect(rep.reasons.join(' ')).toMatch(/H1 FAIL/);
  });
  it('PASS_WITH_BUFFER when a correction was being spoken but its speech signal arrived after tool.call', () => {
    const lines: RawLine[] = [
      inn(2000, { type: 'input.speech.stopped' }), inn(2100, { type: 'transcript.user', text: 'Two burgers.' }),
      marker(2200, 'correction:late'),
      inn(2400, { type: 'tool.call', call_id: 'c1', name: 'add_item', arguments: {} }),
      out(2450, { type: 'tool.result', call_id: 'c1', result: '{}' }),
      inn(2700, { type: 'input.speech.started' }), // signal only arrives 500 ms after the correction began, and after the call
    ];
    const rep = judge([analyseRun('late', lines)]);
    expect(rep.verdict).toBe('PASS_WITH_BUFFER');
    expect(rep.suggested_buffer_ms).toBe(700); // ceil((500+200)/50)*50
  });
  it('a correction that begins after the call is not blind (re-validation handles it)', () => {
    const lines = [...cleanHold, marker(6000, 'correction:after'), inn(6100, { type: 'input.speech.started' })];
    expect(judge([analyseRun('a', lines)]).stats).toMatchObject({ blind_corrections: 0 });
  });
  it('FAIL when a correction during hold produced no speech signal before the result was due', () => {
    const lines: RawLine[] = [
      inn(2000, { type: 'input.speech.stopped' }), inn(2100, { type: 'transcript.user', text: 'Two burgers.' }),
      inn(2400, { type: 'tool.call', call_id: 'c1', name: 'add_item', arguments: {} }),
      out(4900, { type: 'tool.result', call_id: 'c1', result: '{}' }),
      inn(5200, { type: 'transcript.user', text: 'No wait, make it three.' }),
    ];
    expect(judge([analyseRun('correction_during_hold', lines)]).verdict).toBe('FAIL');
  });
});

describe('speech vs silence padding (run-1 finding)', () => {
  const withAudio = (rms: number | undefined): RawLine[] => {
    const lines = cleanHold.filter((l) => !(l.dir === 'in' && ['reply.started', 'reply.audio', 'reply.done'].includes((l.msg as any).type)));
    lines.push(inn(2200, { type: 'reply.started' }), inn(2210, { type: 'reply.audio', data: '<480 bytes>', ...(rms === undefined ? {} : { rms }) }), inn(2300, { type: 'reply.audio', data: '<480 bytes>', ...(rms === undefined ? {} : { rms }) }));
    return lines.sort((a, b) => a.t_ms - b.t_ms);
  };
  it('silence frames (rms 0) before tool.call are NOT counted as the agent speaking', () => {
    const c = analyseRun('x', withAudio(0)).calls[0]!;
    expect(c.spoke_before_call).toBe(false);
    expect(c.silent_audio_before_call_ms).toBe(20);
    expect(c.loud_audio_before_call_ms).toBe(0);
  });
  it('audible frames before tool.call ARE counted as speech', () => {
    const rep = judge([analyseRun('x', withAudio(1800))]);
    expect(rep.verdict).toBe('FAIL');
  });
  it('without energy data it falls back to reply.started (old captures), conservatively', () => {
    expect(analyseRun('x', withAudio(undefined)).calls[0]!.spoke_before_call).toBe(true);
  });
});
