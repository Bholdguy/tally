// Independent-stream DROPOUT mid-hold must FAIL CLOSED: hold promptly, never hang, never silently allow (owner requirement).
// These tests assert observed behaviour, not design intent: timing bounds are measured against a deterministic clock.
import { describe, expect, it } from 'vitest';
import type { TallyEvent } from '@tally/contract';
import { EvidenceTracker } from '../src/evidence.js';
import { Gate } from '../src/gate.js';
import { systemClock } from '../src/clock.js';
import { makeRig } from './rig.js';

const CALL = { item_id: 'burger', quantity: 2, modifiers: [] as string[] };

describe('dropout mid-hold: gate + scripted evidence source (deterministic clock)', () => {
  it('HARD DROP during the wait: holds at the moment of the drop, NOT at the 4 s timeout; order unchanged; recorded', async () => {
    const r = makeRig();
    r.up();
    r.final('two burgers.');            // evidence that WOULD have matched the call if the gate ignored the in-flight speech
    r.localStart();                     // customer starts speaking again (a correction)
    r.clock.at(500, () => r.speechStarted());
    r.clock.at(1200, () => r.down('socket closed (code 1006)'));
    const before = r.hash();
    const res = await r.call('add_item', CALL);
    expect(res).toMatchObject({ verdict: 'HOLD', code: 'UNVALIDATABLE' });
    if (res.verdict !== 'HOLD') throw new Error('unreachable');
    expect(res.detail).toMatch(/independent evidence stream is down/);
    expect(res.detail).toMatch(/socket closed/);
    expect(res.waited_ms!).toBeGreaterThanOrEqual(1200);
    expect(res.waited_ms!).toBeLessThan(1200 + 100);   // reacts within a poll interval of the drop, far below the 4000 ms timeout
    expect(r.hash()).toBe(before);                      // nothing committed
    expect(r.toolCalls().at(-1)).toMatchObject({ status: 'held', conflict_type: 'UNVALIDATABLE' });
    expect(res.repair?.ask_text).toBeTruthy();          // the agent is told to ask the customer to repeat
    r.close();
  });

  it('SILENT STALL: speech in flight, stream "up" but sends nothing: holds at the stall bound, not the full timeout', async () => {
    const r = makeRig();
    r.up();
    r.final('two burgers.');
    r.localStart();                                     // local VAD hears speech; the independent stream never reacts
    const before = r.hash();
    const res = await r.call('add_item', CALL);
    expect(res).toMatchObject({ verdict: 'HOLD', code: 'UNVALIDATABLE' });
    if (res.verdict !== 'HOLD') throw new Error('unreachable');
    expect(res.detail).toMatch(/silent while speech is in flight/);
    expect(res.waited_ms!).toBeGreaterThanOrEqual(2500);
    expect(res.waited_ms!).toBeLessThan(2600);
    expect(res.waited_ms!).toBeLessThan(4000);
    expect(r.hash()).toBe(before);
    r.close();
  });

  it('drop BEFORE the call: immediate hold (zero wait)', async () => {
    const r = makeRig();
    r.up(); r.final('two burgers.'); r.down('network unreachable');
    const res = await r.call('add_item', CALL);
    expect(res).toMatchObject({ verdict: 'HOLD', code: 'UNVALIDATABLE', waited_ms: 0 });
    r.close();
  });

  it('drop that happens after the speech was resolved but before the call still holds (no "evidence is already in hand" shortcut)', async () => {
    const r = makeRig();
    r.up(); r.final('two burgers.');
    r.localStart(); r.clock.advance(300); r.speechStarted(); r.clock.advance(900); r.final('two burgers. No, wait, make it 3.'); r.localEnd();
    r.down('socket closed');
    const res = await r.call('add_item', { ...CALL, quantity: 3 });
    expect(res).toMatchObject({ verdict: 'HOLD', code: 'UNVALIDATABLE' });
    r.close();
  });

  it('NO HANG: speech that never finalises is bounded by EVIDENCE_WAIT_MAX_MS and holds PENDING_EVIDENCE', async () => {
    const r = makeRig();
    r.up(); r.final('two burgers.');
    r.localStart(); r.clock.advance(400); r.speechStarted(); // stream alive and acknowledging (as in spike A, ~0.5 s after onset), but never finalises
    const res = await r.call('add_item', CALL);
    expect(res).toMatchObject({ verdict: 'HOLD', code: 'PENDING_EVIDENCE' });
    if (res.verdict !== 'HOLD') throw new Error('unreachable');
    expect(res.waited_ms!).toBeGreaterThanOrEqual(4500);
    expect(res.waited_ms!).toBeLessThan(4600);
    r.close();
  });

  it('a drop never turns into an ALLOW on retry: same call id keeps its HOLD; a NEW call after reconnect is judged on fresh evidence', async () => {
    const r = makeRig();
    r.up(); r.final('two burgers.'); r.down('flap');
    const first = await r.call('add_item', CALL, 'cid-1');
    expect(first.verdict).toBe('HOLD');
    r.up();                                             // reconnected
    const replay = await r.call('add_item', CALL, 'cid-1');
    expect(replay).toMatchObject({ verdict: 'HOLD', code: 'UNVALIDATABLE' });   // recorded decision is final for that call id
    const fresh = await r.call('add_item', CALL, 'cid-2');
    expect(fresh.verdict).toBe('ALLOW');                // evidence is complete and matches once the stream is back
    r.close();
  });

  it('the stream going down while nothing is being said does not block later calls once it is back up', async () => {
    const r = makeRig();
    r.up(); r.down('blip'); r.up(); r.final('a coke');
    expect((await r.call('add_item', { item_id: 'coke', quantity: 1, modifiers: [] })).verdict).toBe('ALLOW');
    r.close();
  });
});

describe('dropout mid-hold: REAL wall clock (proves it does not hang)', () => {
  it('drop 150 ms into a real 4000 ms wait: the gate returns HOLD in well under 1 s', async () => {
    const r = makeRig({ clock: systemClock });
    const tracker = new EvidenceTracker({ sttStallMs: 2500 });
    const gate = new Gate({ store: r.store, evidenceFor: () => tracker, clock: systemClock });
    const push = (e: Record<string, unknown>) => tracker.ingest({ id: `x${Math.random()}`, session_id: r.session, t_ms: performance.now(), wall_ms: 0, audio_offset_ms: 0, ...e } as TallyEvent);
    push({ kind: 'evidence_stream_status', status: 'up' });
    push({ kind: 'evidence_transcript', text: 'two burgers.', end_of_turn: true, turn_order: 0, words: [{ text: 'two', confidence: 0.9 }, { text: 'burgers.', confidence: 0.9 }] });
    push({ kind: 'local_vad', state: 'speech_start' });
    push({ kind: 'evidence_speech_started' });
    setTimeout(() => push({ kind: 'evidence_stream_status', status: 'down', reason: 'network drop' }), 150);
    const t0 = performance.now();
    const before = r.hash();
    const res = await gate.submit({ session_id: r.session, aai_call_id: 'real-clock-1', tool: 'add_item', args: CALL, received_t_ms: 0 });
    const wall = performance.now() - t0;
    expect(res).toMatchObject({ verdict: 'HOLD', code: 'UNVALIDATABLE' });
    expect(wall).toBeGreaterThanOrEqual(140);
    expect(wall).toBeLessThan(600);
    expect(r.hash()).toBe(before);
    r.close();
  });
});
