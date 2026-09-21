import { existsSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { TallyEvent } from '@tally/contract';
import { agentEventsFromCapture } from '../../scripts/lib/wire-replay.js';
import { loadCapture } from '../../scripts/lib/capture.js';
import { Ingest, textInstability } from '../src/ingest.js';
import { makeRig } from './rig.js';

let n = 0;
const ev = (t: number, e: Record<string, unknown>, session = 's1') => ({ id: `i${++n}`, session_id: session, t_ms: t, wall_ms: 0, audio_offset_ms: t, ...e }) as TallyEvent;
const words = (text: string, conf = 0.9) => text.split(/\s+/).map((w) => ({ text: w, confidence: conf }));
const q = (r: ReturnType<typeof makeRig>, sql: string, ...p: unknown[]) => r.store.r.prepare(sql).all(...p) as any[];

describe('textInstability (D-03 complement)', () => {
  it('0 when the partial equals the final; grows with divergence', () => {
    expect(textInstability('two burgers', 'Two burgers.')).toBe(0);
    expect(textInstability('two burgers', 'two burgers and a coke')).toBeCloseTo(0.6, 5);
    expect(textInstability('', '')).toBe(0);
    expect(textInstability('no wait', 'make it three')).toBe(1);
  });
});

describe('Ingest: persistence with provenance', () => {
  it('persists every event losslessly in events_raw, with server timestamps, and is idempotent on replay', () => {
    const r = makeRig(); const ing = new Ingest(r.store);
    const e = ev(10, { kind: 'input_speech_started', server_ts_ms: 1789857214405 });
    ing.push(e); ing.push(e);                                         // replayed event id
    const rows = q(r, 'SELECT id,type,t_ms,server_ts_ms,payload_json FROM events_raw WHERE session_id=?', 's1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'input_speech_started', t_ms: 10, server_ts_ms: 1789857214405 });
    expect(JSON.parse(rows[0].payload_json).kind).toBe('input_speech_started');
    r.close();
  });

  it('agent-stream user transcripts: partials and finals, with text-instability on the final', () => {
    const r = makeRig(); const ing = new Ingest(r.store);
    ing.push(ev(1, { kind: 'transcript_user_delta', text: '2 burgers', item_id: 'm1' }));
    ing.push(ev(2, { kind: 'transcript_user', text: '2 burgers and a coke.', item_id: 'm1' }));
    const u = q(r, "SELECT is_partial,text,instability,source,speaker FROM utterances WHERE session_id=? ORDER BY t_ms", 's1');
    expect(u).toEqual([
      expect.objectContaining({ is_partial: 1, text: '2 burgers', source: 'agent_stream', speaker: 'user', instability: null }),
      expect.objectContaining({ is_partial: 0, text: '2 burgers and a coke.', source: 'agent_stream', speaker: 'user' }),
    ]);
    expect(u[1].instability).toBeCloseTo(0.6, 5);
    r.close();
  });

  it('agent speech is stored as speaker=agent with the interrupted flag', () => {
    const r = makeRig(); const ing = new Ingest(r.store);
    ing.push(ev(1, { kind: 'transcript_agent', text: 'Got it, three burgers.', reply_id: 'r1', interrupted: true }));
    expect(q(r, "SELECT speaker,interrupted,reply_id FROM utterances WHERE session_id=?", 's1')).toEqual([{ speaker: 'agent', interrupted: 1, reply_id: 'r1' }]);
    r.close();
  });

  it('independent-stream turns keep per-word confidence (min stored in confidence, words in words_json) and are tagged independent_stt', () => {
    const r = makeRig(); const ing = new Ingest(r.store);
    ing.push(ev(1, { kind: 'evidence_transcript', text: 'No, wait, make it 3.', end_of_turn: true, turn_order: 1, words: [{ text: 'No,', confidence: 0.9 }, { text: 'wait,', confidence: 0.85 }, { text: 'make', confidence: 0.9 }, { text: 'it', confidence: 0.9 }, { text: '3.', confidence: 0.63 }] }));
    const [u] = q(r, "SELECT source,confidence,is_partial,words_json FROM utterances WHERE session_id=?", 's1');
    expect(u).toMatchObject({ source: 'independent_stt', confidence: 0.63, is_partial: 0 });
    expect(JSON.parse(u.words_json)).toHaveLength(5);
    r.close();
  });

  it('VAD events from all three sources are stored with their source; a derived barge-in is stored derived=1 with its reaction time', () => {
    const r = makeRig(); const ing = new Ingest(r.store);
    ing.push(ev(1, { kind: 'reply_started' })); ing.push(ev(2, { kind: 'reply_audible' }));
    ing.push(ev(3, { kind: 'input_speech_started' })); ing.push(ev(3, { kind: 'reply_done', status: 'interrupted' }));
    ing.push(ev(4, { kind: 'local_vad', state: 'speech_start' })); ing.push(ev(5, { kind: 'evidence_speech_started' })); ing.push(ev(6, { kind: 'input_speech_stopped' }));
    const v = q(r, 'SELECT type,derived,source,reaction_ms FROM vad_events WHERE session_id=? ORDER BY t_ms, source', 's1');
    expect(v.map((x) => `${x.source}:${x.type}`).sort()).toEqual(['agent:speech_end', 'agent:speech_start', 'derived:barge_in', 'independent:speech_start', 'local:speech_start']);
    expect(v.find((x) => x.type === 'barge_in')).toMatchObject({ derived: 1, source: 'derived' });
    expect(ing.stats.barge_ins).toBe(1);
    r.close();
  });

  it('entities carry provenance and a correction SUPERSEDES the earlier quantity (last mention wins)', () => {
    const r = makeRig(); const ing = new Ingest(r.store);
    ing.push(ev(1, { kind: 'evidence_transcript', text: '2 burgers, no onions.', end_of_turn: true, turn_order: 0, words: words('2 burgers, no onions.') }));
    ing.push(ev(2, { kind: 'evidence_transcript', text: 'No, wait, make it 3.', end_of_turn: true, turn_order: 1, words: words('No, wait, make it 3.') }));
    const ents = q(r, 'SELECT id,type,value,item_ref,cue,superseded_by,source_utterance_id FROM entities WHERE session_id=? ORDER BY extracted_at, id', 's1');
    const qty = ents.filter((e) => e.type === 'quantity');
    expect(qty.map((e) => e.value).sort()).toEqual(['2', '3']);
    const two = qty.find((e) => e.value === '2')!; const three = qty.find((e) => e.value === '3')!;
    expect(two.superseded_by).toBe(three.id);
    expect(three.superseded_by).toBeNull();
    expect(three.cue).toBe('correction');
    expect(ents.find((e) => e.type === 'removal' && e.value === 'no_onions')).toBeTruthy();
    expect(ents.find((e) => e.type === 'item' && e.value === 'burger')).toBeTruthy();
    // provenance: every entity points at an existing independent utterance (foreign key enforced) and the right one
    const utt = new Map(q(r, 'SELECT id,text FROM utterances WHERE session_id=?', 's1').map((u) => [u.id, u.text]));
    for (const e of ents) expect(utt.has(e.source_utterance_id), e.id).toBe(true);
    expect(utt.get(three.source_utterance_id)).toBe('No, wait, make it 3.');
    r.close();
  });

  it('pickup time and substitutions become entities too', () => {
    const r = makeRig(); const ing = new Ingest(r.store);
    ing.push(ev(1, { kind: 'evidence_transcript', text: 'a burger with chicken instead of beef, pickup as soon as possible', end_of_turn: true, turn_order: 0, words: words('a burger with chicken instead of beef, pickup as soon as possible') }));
    const ents = q(r, 'SELECT type,value FROM entities WHERE session_id=?', 's1');
    expect(ents).toEqual(expect.arrayContaining([{ type: 'substitution', value: 'sub_chicken_for_beef' }, { type: 'pickup_time', value: 'ASAP' }]));
    r.close();
  });

  it('partial independent turns produce utterances but NO entities (only finalised speech is evidence)', () => {
    const r = makeRig(); const ing = new Ingest(r.store);
    ing.push(ev(1, { kind: 'evidence_transcript', text: '2 burg', end_of_turn: false, turn_order: 0, words: [] }));
    expect(q(r, 'SELECT count(*) c FROM utterances WHERE session_id=?', 's1')[0].c).toBe(1);
    expect(q(r, 'SELECT count(*) c FROM entities WHERE session_id=?', 's1')[0].c).toBe(0);
    r.close();
  });

  it('a storage failure is counted and reported, never thrown into the audio/event path', () => {
    const r = makeRig(); const errors: unknown[] = [];
    const ing = new Ingest(r.store, { onError: (e) => errors.push(e) });
    expect(() => ing.push(ev(1, { kind: 'input_speech_started' }, 'no-such-session'))).not.toThrow();   // FK violation
    expect(ing.stats.errors).toBe(1);
    expect(errors).toHaveLength(1);
    ing.push(ev(2, { kind: 'input_speech_started' }));                                                    // recovers for a good session
    expect(ing.stats.errors).toBe(1);
    expect(q(r, 'SELECT count(*) c FROM events_raw WHERE session_id=?', 's1')[0].c).toBe(1);
    r.close();
  });

  it('session_ended stamps ended_at exactly once', () => {
    const r = makeRig(); const ing = new Ingest(r.store);
    expect(q(r, 'SELECT ended_at FROM sessions WHERE id=?', 's1')[0].ended_at).toBeNull();
    ing.push(ev(9, { kind: 'session_ended' }));
    const first = q(r, 'SELECT ended_at FROM sessions WHERE id=?', 's1')[0].ended_at;
    expect(first).toBeGreaterThan(0);
    ing.push(ev(10, { kind: 'session_ended' }));
    expect(q(r, 'SELECT ended_at FROM sessions WHERE id=?', 's1')[0].ended_at).toBe(first);
    r.close();
  });
});

const A = 'fixtures/aai-events-A-hold';
const have = existsSync(`${A}/late_correction_900ms-1.stt.jsonl`);

describe.skipIf(!have)('Ingest on a REAL capture (agent stream + independent stream + local speech check)', () => {
  it('late_correction_900ms-1: everything is stored, the correction exists ONLY as an independent-stream utterance, and provenance holds', () => {
    const r = makeRig(); const ing = new Ingest(r.store);
    const cap = loadCapture(A, 'late_correction_900ms-1', r.session);
    const agent = agentEventsFromCapture(`${A}/late_correction_900ms-1.jsonl`, r.session).map((e) => ({ ...e, session_id: r.session }));
    const all = [...agent, ...cap.events.map((e) => ({ ...e, session_id: r.session }))].sort((a, b) => a.t_ms - b.t_ms);
    for (const e of all) ing.push(e as TallyEvent);

    expect(ing.stats.errors).toBe(0);
    expect(q(r, 'SELECT count(*) c FROM events_raw WHERE session_id=?', r.session)[0].c).toBe(new Set(all.map((e) => e.id)).size);

    // the spike-g5 finding, now visible in the database itself:
    const agentUser = q(r, "SELECT text FROM utterances WHERE session_id=? AND source='agent_stream' AND speaker='user' AND is_partial=0", r.session).map((u) => u.text);
    const indep = q(r, "SELECT text,confidence FROM utterances WHERE session_id=? AND source='independent_stt' AND is_partial=0", r.session);
    expect(agentUser.some((t: string) => /make it 3/i.test(t))).toBe(false);          // the agent's live stream never delivered the correction
    expect(indep.some((u) => /make it 3/i.test(u.text))).toBe(true);                   // Tally's independent stream did
    expect(indep.every((u) => u.confidence === null || (u.confidence >= 0 && u.confidence <= 1))).toBe(true);

    const three = q(r, "SELECT e.value,e.source_utterance_id,u.text,u.source FROM entities e JOIN utterances u ON u.id=e.source_utterance_id WHERE e.session_id=? AND e.type='quantity' AND e.superseded_by IS NULL", r.session);
    expect(three).toEqual([expect.objectContaining({ value: '3', source: 'independent_stt' })]);
    // all three speech sources were recorded
    const sources = new Set(q(r, 'SELECT DISTINCT source FROM vad_events WHERE session_id=?', r.session).map((x) => x.source));
    expect(sources).toEqual(new Set(['agent', 'independent', 'local']));
    r.close();
  });

  it('every agent event in every capture carries a server timestamp, and server order == arrival order (D-05: safe to prefer it)', () => {
    let events = 0; let inversions = 0; let missing = 0;
    for (const dir of ['fixtures/aai-events', 'fixtures/aai-events-A-hold', 'fixtures/aai-events-B-interactive']) {
      for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl') && !x.endsWith('.stt.jsonl'))) {
        let last = -Infinity;
        for (const e of agentEventsFromCapture(`${dir}/${f}`)) {
          events++;
          if (e.server_ts_ms === undefined) { missing++; continue; }
          if (e.server_ts_ms + 5 < last) inversions++;   // 5 ms tolerance for sub-ms float rounding
          last = Math.max(last, e.server_ts_ms);
        }
      }
    }
    expect(events).toBeGreaterThan(1000);
    expect(missing).toBe(0);
    expect(inversions).toBe(0);
  });
});
