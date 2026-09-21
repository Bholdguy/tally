// STEP 10 end to end through the real SessionRuntime (mock Voice Agent + mock streaming STT; REAL fixture audio, recorder, VAD, gate,
// committer, drift check): scenario B, then the agent mis-states the order aloud and Tally has it corrected. Real clock.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Secret } from '@tally/agent';
import { initDatabase } from '@tally/db';
import { Store } from '@tally/reliability';
import type { TallyEvent } from '@tally/contract';
import { parseWav, toPcm24k } from '../../scripts/lib/real-speech.js';
import { SessionRuntime } from '../src/runtime.js';
import { mockAgent, mockStt, until, wait, type MockAgent } from './mocks.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function rig() {
  const agent = await mockAgent(); const stt = await mockStt();
  const dir = mkdtempSync(join(tmpdir(), 'tally-s10-'));
  initDatabase(join(dir, 't.sqlite'));
  const store = new Store(join(dir, 't.sqlite'));
  const events: TallyEvent[] = [];
  const rt = await SessionRuntime.start({ agentConfig: { apiKey: new Secret('k-0000000'), wsUrl: agent.url, restUrl: 'http://x' }, store, audioDir: join(dir, 'audio'), mode: 'demo', stt: { url: stt.url }, onEvent: (e) => events.push(e), regressionThreshold: 5 });
  cleanups.push(async () => { await rt.end().catch(() => undefined); store.close(); await agent.close(); await stt.close(); });
  return { rt, agent, stt, store, events };
}
const q = (s: Store, sql: string, ...p: unknown[]) => s.r.prepare(sql).all(...p) as any[];
const call = (agent: MockAgent, id: string, args: unknown) => agent.push({ type: 'tool.call', call_id: id, name: 'add_item', arguments: args });
/** the agent speaks: reply.started, its transcript, reply.done (the order the Voice Agent API delivers them) */
const speak = (agent: MockAgent, id: string, text: string) => {
  agent.push({ type: 'reply.started', reply_id: id });
  agent.push({ type: 'transcript.agent', text, reply_id: id });
  agent.push({ type: 'reply.done', status: 'completed', reply_id: id });
};
const creates = (agent: MockAgent) => agent.received.filter((m) => m.type === 'reply.create');

describe('STEP 10: scenario B from fixture audio, then a spoken drift is corrected', () => {
  it('final order = burger x3, total 2697, every change paired with an audit row; the agent mis-states the order aloud; Tally has it corrected (reply.create) until it is right', async () => {
    const { rt, agent, stt, store, events } = await rig();
    const wav = readFileSync(new URL('../../fixtures/audio/spike/no_wait_three.wav', import.meta.url));
    const pcm = toPcm24k(parseWav(new Uint8Array(wav)));
    await rt.sendPcm(pcm);                                                             // the REAL clip, at 1x, to agent + recorder + independent stream + local check
    await wait(150);
    stt.speechStarted(); stt.final('Two burgers, no wait, make it three.', 0);
    await wait(80);

    // 1) the agent's stale call is HELD with a scoped question; the order is untouched
    call(agent, 'k1', { item_id: 'burger', quantity: 2, modifiers: [] });
    const held = await agent.result('k1');
    expect(held).toMatchObject({ status: 'HELD', code: 'QTY_MISMATCH' });
    expect(held.instruction).toContain("Just to confirm, that's 3 classic burgers?");
    expect(store.getOrder(rt.session_id)!.state.lines).toEqual([]);

    // 2) the customer confirms; the re-issued call re-validates and commits; the total is recomputed
    stt.final('Yes, three.', 1); await wait(80);
    call(agent, 'k2', { item_id: 'burger', quantity: 3, modifiers: [] });
    const ok = await agent.result('k2');
    expect(ok).toMatchObject({ status: 'OK', total: '$26.97' });
    expect(ok.order[0].spoken).toBe('3 classic burgers');
    expect(store.getOrder(rt.session_id)).toMatchObject({ total_cents: 2697, state: { lines: [{ item_id: 'burger', quantity: 3, modifiers: [] }] } });

    // 3) the agent then MIS-STATES the order aloud (the LLM is free to): wrong quantity AND wrong total
    speak(agent, 'r1', "Okay, two burgers, that's $17.98 in total.");
    await until(() => creates(agent).length === 1, 3000, 'first correction');
    expect(creates(agent)[0].instructions).toContain('Your order has 3 classic burgers');
    expect(store.getOrder(rt.session_id)!.total_cents).toBe(2697);                       // speech changed nothing

    // 4) the corrected reply is itself checked: a right statement resolves that scope; the queued total correction goes out after this reply
    speak(agent, 'r2', 'You have three burgers.');
    await until(() => creates(agent).length === 2, 3000, 'second correction');
    expect(creates(agent)[1].instructions).toContain('Your total is $26.97');
    speak(agent, 'r3', 'Your total is $26.97.');
    await until(() => q(store, "SELECT count(*) n FROM repair_events WHERE reason IN ('SPOKEN_STATE_DRIFT','TOTAL_MISMATCH') AND outcome='resolved'")[0].n === 2, 3000, 'both drifts resolved');
    expect(events.filter((e) => e.kind === 'repair').map((e) => `${(e as { outcome: string }).outcome}:${(e as { scope: string }).scope}`)).toEqual(['asked:burger', 'resolved:burger', 'asked:burger', 'asked:order', 'resolved:burger', 'resolved:order']);

    // what Tally is allowed to send to the agent is exactly: session config, audio, tool results, and one-shot reply.create corrections
    expect(new Set(agent.received.map((m) => m.type))).toEqual(new Set(['session.update', 'input.audio', 'tool.result', 'reply.create']));
    for (const c of creates(agent)) { expect(c.instructions).not.toMatch(/_/); expect(c.instructions).toMatch(/Do not call any tool/); }

    // the repairs and cases: two drift disputes, both resolved; no unresolved drift left at hangup
    const drift = q(store, "SELECT scope, outcome FROM repair_events WHERE reason IN ('SPOKEN_STATE_DRIFT','TOTAL_MISMATCH') ORDER BY rowid");
    expect(drift).toEqual([{ scope: 'burger', outcome: 'resolved' }, { scope: 'order', outcome: 'resolved' }]);
    expect(q(store, "SELECT resolution FROM cases WHERE conflict_type IN ('SPOKEN_STATE_DRIFT','TOTAL_MISMATCH') ORDER BY rowid").map((c) => c.resolution)).toEqual(['resolved', 'resolved']);
    await rt.end();
    expect(q(store, "SELECT count(*) n FROM cases WHERE resolution='unresolved_at_hangup'")[0].n).toBe(0);

    // FINAL STATE + AUDIT: items_json is exactly what the customer said; every order change has a paired audit row; the chain is unbroken
    const order = q(store, 'SELECT items_json, total, last_validation_event_id FROM orders WHERE session_id=?', rt.session_id)[0];
    expect(JSON.parse(order.items_json)).toEqual([{ item_id: 'burger', quantity: 3, modifiers: [] }]);
    expect(order.total).toBe(3 * 899);
    const chain = q(store, "SELECT action, before_state, after_state, validation_event_id FROM audit_events WHERE session_id=? AND (action='order_opened' OR action LIKE 'commit:%') ORDER BY rowid", rt.session_id);
    expect(chain.map((c) => c.action)).toEqual(['order_opened', 'commit:add_item']);
    expect(JSON.parse(chain[1].before_state)).toEqual(JSON.parse(chain[0].after_state));      // each change starts from the previous state
    expect(JSON.parse(chain[1].after_state).lines).toEqual(JSON.parse(order.items_json));      // and the last one ends at what the order holds
    expect(chain[1].validation_event_id).toBe(order.last_validation_event_id);
    expect(q(store, "SELECT status FROM tool_calls WHERE validation_event_id=? AND tool_name='add_item'", chain[1].validation_event_id)).toEqual([{ status: 'allowed' }]);
  }, 40000);

  it('a drift that never gets fixed is corrected twice, then handed off ONCE; no correction loop; the order is never touched by speech', async () => {
    const { rt, agent, stt, store } = await rig();
    stt.speechStarted(); stt.final('Three burgers.', 0);
    await wait(80);
    call(agent, 'a1', { item_id: 'burger', quantity: 3, modifiers: [] });
    await agent.result('a1');
    const orderBefore = JSON.stringify(store.getOrder(rt.session_id));
    for (let i = 1; i <= 4; i++) {
      speak(agent, `w${i}`, 'Okay, two burgers.');
      await wait(120);
    }
    expect(creates(agent)).toHaveLength(3);                                              // 2 corrections + 1 hand-off, then silence (the 4th wrong statement raises nothing)
    expect(creates(agent)[2].instructions).toMatch(/Do not try to correct it again/);
    expect(creates(agent)[2].instructions).toMatch(/team member will confirm/);
    expect(JSON.stringify(store.getOrder(rt.session_id))).toBe(orderBefore);
    await rt.end();
    expect(q(store, "SELECT resolution FROM cases WHERE conflict_type='SPOKEN_STATE_DRIFT'").every((c) => c.resolution === 'escalated')).toBe(true);
  }, 30000);
});
