// Step 10: closing the loop in runtime. What the agent SAYS about the order is checked against the COMMITTED order; a disagreement becomes a
// scoped spoken-drift repair (data for Plane 1 to speak), with its own attempts/escalation/case, and is resolved only by later CORRECT speech.
// Speech never changes the order and never resolves a hold dispute.
import { describe, expect, it } from 'vitest';
import { replayEvidence } from '../src/replay.js';
import { makeRig, type Rig } from './rig.js';

const B = (q: number) => ({ item_id: 'burger', quantity: q, modifiers: [] as string[] });
const rows = (r: Rig, sql: string, ...p: unknown[]) => r.store.r.prepare(sql).all(...p) as any[];
let n = 0;
const say = (r: Rig, text: string, ctx: { order_version?: string | null; interrupted?: boolean; utterance_id?: string } = {}) =>
  r.gate.handleAgentSpeech(r.session, text, { utterance_id: `u${++n}`, ...ctx });
const withBurgers = (q = 3) => { const r = makeRig({ persist: true, regressionThreshold: 1 }); r.up(); r.final('three burgers.'); r.seed({ tool: 'add_item', args: B(q) }); return r; };

describe('spoken drift becomes a scoped, stored, repairable conflict', () => {
  it('quantity drift: the agent says two, the order has three -> a correction stating the TRUE quantity; recorded as a claim + repair + case; the order is untouched', () => {
    const r = withBurgers();
    const before = r.hash();
    const out = say(r, 'Got it, two burgers.');
    expect(out.findings).toHaveLength(1);
    expect(out.repairs).toEqual([expect.objectContaining({ code: 'SPOKEN_STATE_DRIFT', item_id: 'burger', evidenced_value: '3', attempt: 1, ask_text: 'Let me correct that. Your order has 3 classic burgers. Is that right?' })]);
    expect(r.hash()).toBe(before);
    expect(rows(r, "SELECT tool_name, status, conflict_type, execution_mode FROM tool_calls WHERE tool_name='agent_speech'")).toEqual([{ tool_name: 'agent_speech', status: 'conflict', conflict_type: 'SPOKEN_STATE_DRIFT', execution_mode: 'interactive' }]);
    expect(rows(r, "SELECT reason, scope, outcome, attempt FROM repair_events")).toEqual([{ reason: 'SPOKEN_STATE_DRIFT', scope: 'burger', outcome: 'pending', attempt: 1 }]);
    const c = r.store.getCase(r.store.listCases()[0]!.id)!;
    expect(c).toMatchObject({ conflict_type: 'SPOKEN_STATE_DRIFT', pattern_key: 'SPOKEN_STATE_DRIFT|agent_speech|plain_statement|na', resolution: 'open' });
    expect(JSON.parse(c.event_snapshot_json).call).toMatchObject({ tool: 'agent_speech', args: { text: 'Got it, two burgers.', item_id: 'burger' } });
    r.close();
  });

  it('total drift: the agent says $17.98, the recomputed total is $26.97 -> the correction states $26.97', () => {
    const r = withBurgers();
    const out = say(r, "That's $17.98 in total.");
    expect(out.repairs).toEqual([expect.objectContaining({ code: 'TOTAL_MISMATCH', evidenced_value: '$26.97', ask_text: 'Let me correct that. Your total is $26.97.' })]);
    expect(rows(r, 'SELECT scope FROM repair_events')).toEqual([{ scope: 'order' }]);
    r.close();
  });

  it('claiming something that is not on the order at all', () => {
    const r = withBurgers();
    const out = say(r, "I've added two cokes.");
    expect(out.repairs[0]).toMatchObject({ code: 'SPOKEN_STATE_DRIFT', item_id: 'coke', evidenced_value: 'not_on_order', ask_text: "Let me correct that. I don't have any cokes on your order." });
    r.close();
  });

  it('nothing is raised when the agent is right, asks a question, or says nothing about the order', () => {
    const r = withBurgers();
    for (const t of ['Got it, three burgers.', 'Did you want two burgers?', 'Anything else today?', "That's $26.97."]) expect(say(r, t)).toMatchObject({ findings: [], repairs: [] });
    expect(rows(r, 'SELECT count(*) n FROM repair_events')[0].n).toBe(0);
    r.close();
  });
});

describe('guards against a false correction', () => {
  it('if the order changed while the agent was speaking, the statement is ambiguous: nothing is raised (audited)', () => {
    const r = withBurgers();
    const version = r.gate.orderVersion(r.session);
    r.seed({ tool: 'update_quantity', args: { item_id: 'burger', quantity: 4 } });          // the order moves on during the reply
    const out = say(r, 'Got it, three burgers.', { order_version: version });                // ...so "three" may have been true when it was said
    expect(out).toMatchObject({ repairs: [], skipped: 'order_changed_during_reply' });
    expect(rows(r, "SELECT action FROM audit_events WHERE action LIKE 'drift_skipped:%'")).toEqual([{ action: 'drift_skipped:order_changed_during_reply' }]);
    expect(say(r, 'Got it, three burgers.', { order_version: r.gate.orderVersion(r.session) }).skipped).toBeUndefined();   // same version: judged normally
    r.close();
  });

  it('an interrupted (partial) reply is not judged', () => {
    const r = withBurgers();
    expect(say(r, 'Got it, two burgers.', { interrupted: true })).toMatchObject({ repairs: [], skipped: 'interrupted' });
    r.close();
  });

  it('the same utterance is never raised twice (idempotent)', () => {
    const r = withBurgers();
    const a = say(r, 'Got it, two burgers.', { utterance_id: 'same' });
    const b = say(r, 'Got it, two burgers.', { utterance_id: 'same' });
    expect(a.repairs).toHaveLength(1);
    expect(b.repairs).toHaveLength(0);
    expect(rows(r, 'SELECT count(*) n FROM repair_events')[0].n).toBe(1);
    r.close();
  });
});

describe('resolution, attempts and escalation, kept apart from hold repairs', () => {
  it('a LATER utterance that states the scope correctly resolves the drift; the case gets the committed order as its expected state; a wrong restatement does not', () => {
    const r = withBurgers();
    say(r, 'Got it, two burgers.');
    expect(say(r, 'Sorry, you have two burgers.').resolved).toEqual([]);                    // still wrong: not resolved (and a second attempt is raised)
    for (const t of ['Anything else today?', 'Thanks, one moment.']) expect(say(r, t).resolved).toEqual([]);        // silence about the item is NOT a correction
    const ok = say(r, 'You have three burgers.');
    expect(ok.resolved).toEqual(['burger']);
    expect(rows(r, 'SELECT outcome FROM repair_events ORDER BY rowid').map((x) => x.outcome)).toEqual(['resolved', 'resolved']);
    const c = r.store.getCase(r.store.listCases()[0]!.id)!;
    expect(c.resolution).toBe('resolved');
    expect(JSON.parse(c.expected_state_json!).state.lines).toEqual([{ item_id: 'burger', quantity: 3, modifiers: [] }]);
    r.close();
  });

  it('the total is resolved by a correct total', () => {
    const r = withBurgers();
    say(r, "That's $17.98.");
    expect(say(r, 'Your total is $26.97.').resolved).toEqual(['order']);
    r.close();
  });

  it('two corrections, then a hand-off; after escalation no further corrections (no loop); hold-repair attempts are unaffected', () => {
    const r = withBurgers();
    const seen = [say(r, 'Got it, two burgers.'), say(r, 'Yes, two burgers.'), say(r, 'Right, two burgers.'), say(r, 'Two burgers it is.')];
    expect(seen.map((s) => s.repairs.map((x) => [x.attempt, x.escalated ?? false]))).toEqual([[[1, false]], [[2, false]], [[3, true]], []]);
    expect(seen[2]!.repairs[0]!.ask_text).toMatch(/team member will confirm/);
    expect(rows(r, "SELECT count(*) n FROM repair_events WHERE reason='SPOKEN_STATE_DRIFT'")[0].n).toBe(3);
    expect(rows(r, "SELECT action FROM audit_events WHERE action='drift_after_escalation'")).toHaveLength(1);
    expect(r.store.repairState(r.session, 'burger', 'hold')).toEqual({ pending: 0, escalated: false });   // hold accounting untouched
    r.close();
  });

  it('agent speech never resolves a HOLD dispute, and a re-validated commit never resolves a drift: independent, on the same item', async () => {
    const r = withBurgers();
    r.final('five burgers.', { order: 9 });                                                // customer now says five; the order still has three
    const held = await r.call('update_quantity', { item_id: 'burger', quantity: 4 });       // agent's call is wrong: HOLD dispute on burger
    expect(held).toMatchObject({ verdict: 'HOLD', repair: { attempt: 1 } });
    say(r, 'Got it, two burgers.');                                                        // AND a drift on burger
    expect(say(r, 'You have three burgers.').resolved).toEqual(['burger']);               // resolves the drift only
    expect(r.store.repairState(r.session, 'burger', 'hold').pending).toBe(1);             // the hold dispute is still open
    say(r, 'Now you have two burgers.');                                                   // new drift
    expect((await r.call('update_quantity', { item_id: 'burger', quantity: 5 })).verdict).toBe('ALLOW');   // re-validated commit resolves the HOLD dispute
    expect(r.store.repairState(r.session, 'burger', 'hold').pending).toBe(0);
    expect(r.store.repairState(r.session, 'burger', 'drift').pending).toBe(1);            // ...and leaves the drift open
    r.close();
  });

  it('a drift still open at hangup becomes an unresolved_at_hangup case', () => {
    const r = withBurgers();
    say(r, 'Got it, two burgers.');
    r.store.endSession(r.session);
    expect(r.store.getCase(r.store.listCases()[0]!.id)!.resolution).toBe('unresolved_at_hangup');
    r.close();
  });
});

describe('a drift case replays deterministically through the CURRENT drift check', () => {
  it('PASS (deterministic) while the check still detects it, byte-identical across runs; a broken check FAILS', async () => {
    const r = withBurgers();
    say(r, 'Got it, two burgers.');
    const id = r.store.listCases()[0]!.id;
    const a = await replayEvidence(r.store, id); const b = await replayEvidence(r.store, id);
    expect(a).toMatchObject({ result: 'pass', label: 'PASS (deterministic)' });
    expect(a.diff).toMatchObject({ basis: 'drift_detection', desired: 'DETECT', reason: 'still_detected' });
    expect(a.diff_json).toBe(b.diff_json);
    const broken = await replayEvidence(r.store, id, { drift: () => [], persist: false });
    expect(broken).toMatchObject({ result: 'fail' });
    expect(broken.diff).toMatchObject({ reason: 'DRIFT_NOT_DETECTED' });
    r.close();
  });
});
