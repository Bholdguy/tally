import { describe, expect, it } from 'vitest';
import type { TallyEvent } from '@tally/contract';
import { EvidenceTracker } from '../src/evidence.js';

let n = 0;
const ev = (t: number, e: Record<string, unknown>) => ({ id: `e${++n}`, session_id: 's', t_ms: t, wall_ms: 0, audio_offset_ms: 0, ...e }) as TallyEvent;
const up = (t = 0) => ev(t, { kind: 'evidence_stream_status', status: 'up' });
const down = (t: number, reason = 'x') => ev(t, { kind: 'evidence_stream_status', status: 'down', reason });
const turn = (t: number, text: string, final: boolean, order = 0) => ev(t, { kind: 'evidence_transcript', text, end_of_turn: final, turn_order: order, words: [] });
const ss = (t: number) => ev(t, { kind: 'evidence_speech_started' });
const lstart = (t: number) => ev(t, { kind: 'local_vad', state: 'speech_start' });
const lend = (t: number) => ev(t, { kind: 'local_vad', state: 'speech_end' });

function tracker(...events: TallyEvent[]) { const t = new EvidenceTracker({ sttStallMs: 2500 }); events.forEach((e) => t.ingest(e)); return t; }

describe('EvidenceTracker: stream health (fail closed)', () => {
  it('unknown until a status event arrives: not "up"', () => expect(tracker().snapshot(0).streamStatus).toBe('unknown'));
  it('up, then down with the reason preserved', () => {
    const s = tracker(up(), down(100, 'socket closed (1006)')).snapshot(200);
    expect(s.streamStatus).toBe('down');
    expect(s.streamReason).toBe('socket closed (1006)');
  });
  it('can recover: down then up', () => expect(tracker(up(), down(10), up(20)).snapshot(30).streamStatus).toBe('up'));
});

describe('EvidenceTracker: speech in flight', () => {
  it('nothing said: nothing in flight', () => expect(tracker(up()).snapshot(1000)).toMatchObject({ speechInFlight: false, stalled: false, finals: [] }));

  it('independent SpeechStarted without a final is in flight; a later final resolves it', () => {
    const t = tracker(up(), ss(100));
    expect(t.snapshot(500).speechInFlight).toBe(true);
    t.ingest(turn(1200, 'two burgers.', true));
    expect(t.snapshot(1300)).toMatchObject({ speechInFlight: false });
  });

  it('an un-finalised partial is in flight', () => {
    expect(tracker(up(), turn(100, 'no wait', false, 1)).snapshot(200).speechInFlight).toBe(true);
  });

  it('local speech active is in flight; ended-but-not-finalised is still in flight; resolved only by a final AFTER it ended', () => {
    const t = tracker(up(), lstart(0));
    expect(t.snapshot(100).speechInFlight).toBe(true);
    t.ingest(lend(2000));
    expect(t.snapshot(2100).speechInFlight).toBe(true);                       // ended, no final yet
    t.ingest(turn(1500, 'earlier phrase', true, 0));                          // a final from BEFORE the local run ended does not resolve it
    expect(t.snapshot(2200).speechInFlight).toBe(true);
    t.ingest(turn(3000, 'earlier phrase. no wait, make it 3.', true, 1));
    expect(t.snapshot(3100).speechInFlight).toBe(false);
  });

  it('STALL: local speech with no independent signal after onset for > 2500 ms', () => {
    const t = tracker(up(), lstart(0));
    expect(t.snapshot(2400).stalled).toBe(false);
    const s = t.snapshot(2600);
    expect(s.stalled).toBe(true);
    expect(s.reasons.join(' ')).toMatch(/no independent-stream signal/);
  });

  it('an independent signal AFTER onset acknowledges the speech and prevents a stall', () => {
    const t = tracker(up(), lstart(0), ss(600));
    expect(t.snapshot(4000).stalled).toBe(false);
    expect(t.snapshot(4000).speechInFlight).toBe(true);                       // still waiting for the final, bounded by the gate's wait
  });

  it('a signal from BEFORE the onset (or at the same instant) does not acknowledge it', () => {
    expect(tracker(up(), turn(0, 'two burgers.', true), lstart(0)).snapshot(3000).stalled).toBe(true);
    expect(tracker(up(), turn(-50, 'two burgers.', true), lstart(0)).snapshot(3000).stalled).toBe(true);
  });

  it('only the most recent local run matters (a new run supersedes an old resolved one)', () => {
    const t = tracker(up(), lstart(0), lend(1000), turn(2000, 'a coke', true), lstart(5000));
    expect(t.snapshot(5100).speechInFlight).toBe(true);
  });
});

describe('EvidenceTracker: finals', () => {
  it('returns finalised utterances in turn order and supersedes a turn when its final arrives', () => {
    const t = tracker(up(), turn(100, 'tw', false, 0), turn(200, 'two burgers.', true, 0), turn(900, 'no wait', false, 1), turn(1500, 'no wait, make it 3.', true, 1));
    const s = t.snapshot(2000);
    expect(s.finals.map((u) => u.text)).toEqual(['two burgers.', 'no wait, make it 3.']);
    expect(s.finalTurnOrders).toEqual([0, 1]);
  });
  it('a partial does not appear in finals', () => {
    expect(tracker(up(), turn(100, 'two bur', false, 0)).snapshot(200).finals).toEqual([]);
  });
  it('records when evidence last arrived', () => expect(tracker(up(), ss(700)).snapshot(800).lastEvidenceAt).toBe(700));
});
