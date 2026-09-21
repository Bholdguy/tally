// Step 7: automatic case creation and the regression tagger.
// A case is a stored, replayable failure: real audio pointer that exists + stored events; never seeded.
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { derivePattern } from '../src/cases.js';
import type { CaseNotice } from '../src/gate.js';
import { makeRig } from './rig.js';

const B = (q: number) => ({ item_id: 'burger', quantity: q, modifiers: [] as string[] });
const rows = (r: ReturnType<typeof makeRig>, sql: string, ...p: unknown[]) => r.store.r.prepare(sql).all(...p) as any[];

describe('case creation: every hold becomes a stored, replayable case', () => {
  it('snapshot has audio pointer (file exists), stored events, transcript, call, verdict, order_before; created with the repair record', async () => {
    const r = makeRig({ persist: true });
    r.up(); r.seed({ tool: 'add_item', args: { item_id: 'coke', quantity: 1, modifiers: [] } });
    r.final('three burgers.');
    const held = await r.call('add_item', B(2), 'call-1');
    expect(held).toMatchObject({ verdict: 'HOLD', code: 'QTY_MISMATCH' });
    const cases = r.store.listCases();
    expect(cases).toHaveLength(1);
    const c = r.store.getCase(cases[0]!.id)!;
    expect(c).toMatchObject({ conflict_type: 'QTY_MISMATCH', tag: 'none', origin_mode: 'demo', resolution: 'open', expected_state_json: null, pattern_key: 'QTY_MISMATCH|add_item|plain_statement|na' });
    expect(c.audio_pointer).toBeTruthy();
    expect(existsSync(c.audio_pointer)).toBe(true);
    expect(c.transcript_snapshot).toContain('three burgers');
    const snap = JSON.parse(c.event_snapshot_json);
    expect(snap.call).toMatchObject({ tool: 'add_item', args: B(2) });
    expect(snap.verdict.code).toBe('QTY_MISMATCH');
    expect(snap.order_before.lines).toEqual([{ item_id: 'coke', quantity: 1, modifiers: [] }]);
    expect(snap.events.some((e: { kind: string }) => e.kind === 'evidence_transcript')).toBe(true);
    expect(snap.events.every((e: { raw?: unknown }) => e.raw === undefined)).toBe(true);
    // same transaction as the repair record: both point at the same held tool call
    expect(rows(r, 'SELECT tool_call_id FROM repair_events')[0].tool_call_id).toBe(c.tool_call_id);
    r.close();
  });

  it('no case without stored audio and events: skipped, and never silently (audited with the reason)', async () => {
    const noAudio = makeRig();                                           // no recording at all
    noAudio.up(); noAudio.final('three burgers.');
    await noAudio.call('add_item', B(2));
    expect(noAudio.store.listCases()).toEqual([]);
    expect(rows(noAudio, "SELECT action FROM audit_events WHERE action LIKE 'case_skipped:%'").map((a) => a.action)).toEqual(['case_skipped:no_audio']);

    const gone = makeRig({ persist: true, audioExists: () => false });   // pointer set, file missing
    gone.up(); gone.final('three burgers.');
    await gone.call('add_item', B(2));
    expect(gone.store.listCases()).toEqual([]);

    const replay = makeRig({ persist: true, mode: 'replay' });           // a replay never spawns cases
    replay.up(); replay.final('three burgers.');
    expect((await replay.call('add_item', B(2))).verdict).toBe('HOLD');
    expect(replay.store.listCases()).toEqual([]);
    noAudio.close(); gone.close(); replay.close();
  });

  it('every case in the store has a non-null audio pointer that exists and stored events in its session (nothing seeded)', async () => {
    const r = makeRig({ persist: true });
    r.up(); r.final('three burgers and a coke.');
    for (let i = 0; i < 3; i++) await r.call('add_item', B(2));
    await r.call('add_item', { item_id: 'coke', quantity: 4, modifiers: [] });
    for (const s of r.store.listCases()) {
      const c = r.store.getCase(s.id)!;
      expect(c.audio_pointer).toBeTruthy();
      expect(existsSync(c.audio_pointer)).toBe(true);
      expect(rows(r, 'SELECT count(*) n FROM events_raw WHERE session_id=?', c.session_id)[0].n).toBeGreaterThan(0);
    }
    r.close();
  });

  it('snapshot columns are immutable and cases are never deleted', async () => {
    const r = makeRig({ persist: true });
    r.up(); r.final('three burgers.');
    await r.call('add_item', B(2));
    expect(() => r.store.r.exec("UPDATE cases SET event_snapshot_json='{}'")).toThrow();
    expect(() => r.store.r.exec('DELETE FROM cases')).toThrow();
    r.close();
  });

  it('idempotent per tool call: replaying the same call id, or recordHold twice, yields one case', async () => {
    const r = makeRig({ persist: true });
    r.up(); r.final('three burgers.');
    await r.call('add_item', B(2), 'same');
    await r.call('add_item', B(2), 'same');
    await r.call('add_item', B(2), 'same');
    expect(r.store.listCases()).toHaveLength(1);
    r.close();
  });

  it('atomic with the hold: a failure while writing the case rolls back the hold and its repair record too', () => {
    const r = makeRig({ persist: true });
    r.up(); r.final('three burgers.');
    expect(() => r.store.recordHold({
      session_id: r.session, aai_call_id: 'x', tool: 'add_item', args: B(2), execution_mode: 'hold', status: 'conflict', code: 'QTY_MISMATCH', detail: 'd', evidence: {}, validation_event_id: 'v',
      repair: { scope: 'burger', attempt: 1, prompt: 'p', outcome: 'pending' },
      case: { pattern_key: null as unknown as string, threshold: 3, audio_exists: true, up_to_ms: 10 },
    })).toThrow();
    expect(rows(r, 'SELECT count(*) n FROM tool_calls')[0].n).toBe(0);
    expect(rows(r, 'SELECT count(*) n FROM repair_events')[0].n).toBe(0);
    r.close();
  });
});

describe('the tagger: three repeats flip the pattern, exactly on the third', () => {
  it('cases 1 and 2 stay untagged; the 3rd flips the pattern to regression_candidate (all three); the 4th is tagged on arrival', async () => {
    const notices: CaseNotice[] = [];
    const r = makeRig({ persist: true, onCase: (n) => notices.push(n) });
    r.up(); r.final('three burgers.');
    const tags = () => r.store.listCases().map((c) => c.tag);
    await r.call('add_item', B(2)); expect(tags()).toEqual(['none']);
    await r.call('add_item', B(2)); expect(tags()).toEqual(['none', 'none']);
    expect(r.store.caseCounts()).toMatchObject({ cases: 2, candidates: 0, patterns_flipped: 0 });
    await r.call('add_item', B(2)); expect(tags()).toEqual(['regression_candidate', 'regression_candidate', 'regression_candidate']);
    expect(r.store.caseCounts()).toMatchObject({ cases: 3, candidates: 3, regressions: 0, patterns_flipped: 1 });
    expect(notices.map((n) => n.threshold_reached)).toEqual([false, false, true]);
    await r.call('add_item', B(2)); expect(tags().at(-1)).toBe('regression_candidate');
    expect(r.store.caseCounts().patterns_flipped).toBe(1);
    r.close();
  });

  it('different patterns never collide: two of one and two of another flip nothing', async () => {
    const r = makeRig({ persist: true });
    r.up(); r.final('three burgers and two cokes.');
    await r.call('add_item', B(2)); await r.call('add_item', B(4));                                         // QTY_MISMATCH add_item
    await r.call('add_item', { item_id: 'fries', quantity: 1, modifiers: [] }); await r.call('add_item', { item_id: 'onion_rings', quantity: 1, modifiers: [] }); // UNSUPPORTED / ITEM
    const keys = r.store.listCases().map((c) => c.pattern_key);
    expect(new Set(keys).size).toBeGreaterThan(1);
    expect(r.store.caseCounts()).toMatchObject({ candidates: 0, patterns_flipped: 0 });
    r.close();
  });

  it('a correction pattern is a different pattern from a plain restatement, and position matters', () => {
    const plain = derivePattern({ code: 'QTY_MISMATCH', tool: 'add_item', item_id: 'burger', utterances: ['Three burgers.'] });
    const mid = derivePattern({ code: 'QTY_MISMATCH', tool: 'add_item', item_id: 'burger', utterances: ['Two burgers, no wait, make it three.'] });
    const after = derivePattern({ code: 'QTY_MISMATCH', tool: 'add_item', item_id: 'burger', utterances: ['Two burgers.', 'No, wait, make it three.'] });
    expect(mid.key).toBe('QTY_MISMATCH|add_item|correction|mid_item');
    expect(after.key).toBe('QTY_MISMATCH|add_item|correction|after_item');
    expect(plain.key).toBe('QTY_MISMATCH|add_item|plain_statement|na');
    expect(new Set([plain.key, mid.key, after.key]).size).toBe(3);
  });

  it('evidence-unavailable holds are classified by cause', () => {
    const d = (code: 'UNVALIDATABLE' | 'PENDING_EVIDENCE', detail: string) => derivePattern({ code, tool: 'add_item', utterances: [], detail }).cue_class;
    expect(d('UNVALIDATABLE', 'independent evidence stream is down (x)')).toBe('stream_down');
    expect(d('UNVALIDATABLE', 'low confidence (0.5 < 0.6) on the words')).toBe('low_confidence');
    expect(d('UNVALIDATABLE', 'no finalised customer speech to validate against')).toBe('no_evidence');
    expect(d('PENDING_EVIDENCE', 'customer speech not finalised')).toBe('evidence_timeout');
  });

  it('the threshold is configurable', async () => {
    const r = makeRig({ persist: true, regressionThreshold: 2 });
    r.up(); r.final('three burgers.');
    await r.call('add_item', B(2)); expect(r.store.caseCounts().candidates).toBe(0);
    await r.call('add_item', B(2)); expect(r.store.caseCounts().candidates).toBe(2);
    r.close();
  });
});

describe('resolution, expected state, hangup, and acceptance as a regression', () => {
  it('expected state exists ONLY once the repair resolved by a re-validated commit, and equals the validated order', async () => {
    const r = makeRig({ persist: true });
    r.up(); r.final('three burgers.');
    await r.call('add_item', B(2));
    const id = r.store.listCases()[0]!.id;
    expect(r.store.getCase(id)).toMatchObject({ resolution: 'open', expected_state_json: null });
    expect((await r.call('add_item', B(3))).verdict).toBe('ALLOW');
    const c = r.store.getCase(id)!;
    expect(c.resolution).toBe('resolved');
    const exp = JSON.parse(c.expected_state_json!);
    expect(exp.state.lines).toEqual([{ item_id: 'burger', quantity: 3, modifiers: [] }]);
    expect(exp).toMatchObject({ total_cents: 2697, derived_from: 'resolved_repair' });
    expect(exp.resolving_tool_call_id).toBeTruthy();
    r.close();
  });

  it('escalated disputes are cases with NO expected state, even if a late valid call commits', async () => {
    const r = makeRig({ persist: true });
    r.up(); r.final('three burgers.');
    for (let i = 0; i < 3; i++) await r.call('add_item', B(2));
    expect(r.store.listCases().map((c) => r.store.getCase(c.id)!.resolution)).toEqual(['escalated', 'escalated', 'escalated']);
    await r.call('add_item', B(3));
    for (const s of r.store.listCases()) expect(r.store.getCase(s.id)).toMatchObject({ resolution: 'escalated', expected_state_json: null });
    r.close();
  });

  it('agent-misuse holds are cases too, marked no_repair', async () => {
    const r = makeRig({ persist: true });
    r.up(); r.final('Cancel the burger.');
    await r.call('remove_item', { item_id: 'burger' });
    expect(r.store.getCase(r.store.listCases()[0]!.id)!.resolution).toBe('no_repair');
    r.close();
  });

  it('HANGUP: a dispute still open becomes an unresolved_at_hangup case (pending review): no expected state, cannot be a regression; resolved ones are untouched', async () => {
    const r = makeRig({ persist: true, regressionThreshold: 1 });
    r.up(); r.final('three burgers and a coke.');
    await r.call('add_item', B(2));                                        // stays open
    await r.call('add_item', { item_id: 'coke', quantity: 2, modifiers: [] });   // open, then resolved below
    await r.call('add_item', { item_id: 'coke', quantity: 1, modifiers: [] });   // resolves the coke dispute
    r.store.endSession(r.session);
    const byTool = Object.fromEntries(r.store.listCases().map((c) => [c.id, r.store.getCase(c.id)!]));
    const res = Object.values(byTool).map((c) => c.resolution).sort();
    expect(res).toEqual(['resolved', 'unresolved_at_hangup']);
    const un = Object.values(byTool).find((c) => c.resolution === 'unresolved_at_hangup')!;
    expect(un.expected_state_json).toBeNull();
    expect(un.tag).toBe('regression_candidate');                          // threshold 1: candidate, but...
    expect(r.store.acceptRegression(un.id, 'operator')).toEqual({ ok: false, reason: 'not_resolved' });
    r.close();
  });

  it('acceptance: only a resolved candidate with an expected state becomes tag=regression; audited', async () => {
    const r = makeRig({ persist: true, regressionThreshold: 1 });
    r.up(); r.final('three burgers.');
    await r.call('add_item', B(2));
    const id = r.store.listCases()[0]!.id;
    expect(r.store.acceptRegression('nope', 'operator')).toEqual({ ok: false, reason: 'not_found' });
    expect(r.store.acceptRegression(id, 'operator')).toEqual({ ok: false, reason: 'not_resolved' });      // not resolved yet
    await r.call('add_item', B(3));
    expect(r.store.acceptRegression(id, 'operator')).toEqual({ ok: true });
    expect(r.store.getCase(id)).toMatchObject({ tag: 'regression', accepted_by: 'operator' });
    expect(r.store.caseCounts()).toMatchObject({ regressions: 1 });
    expect(rows(r, "SELECT actor FROM audit_events WHERE action='accept_regression'")).toEqual([{ actor: 'operator' }]);
    expect(r.store.acceptRegression(id, 'operator')).toEqual({ ok: false, reason: 'not_a_candidate' });   // already promoted
    r.close();
  });

  it('a case below the threshold cannot be promoted', async () => {
    const r = makeRig({ persist: true });
    r.up(); r.final('three burgers.');
    await r.call('add_item', B(2)); await r.call('add_item', B(3));
    expect(r.store.acceptRegression(r.store.listCases()[0]!.id, 'operator')).toEqual({ ok: false, reason: 'not_a_candidate' });
    r.close();
  });
});
