// EVIDENCE-TIER REPLAY of REAL spike-A captures through the REAL gate (rule 7: same code path as live).
// Each capture supplies: the independent-stream events (real, from AssemblyAI), the local-VAD transitions computed by the
// production LocalVad on the exact PCM that was streamed, and the agent's real first tool.call. The gate runs on a
// deterministic clock, so the verdicts and waits below are reproducible, not a one-off live observation.
// SYNTHETIC SPEECH, n=3 per scenario: this validates the mechanism against real API timings, not real-world accuracy.
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadCapture } from '../../scripts/lib/capture.js';
import { FakeClock } from '../src/clock.js';
import { makeRig } from './rig.js';

const DIR = 'fixtures/aai-events-A-hold';
const have = existsSync(`${DIR}/late_correction_900ms-1.stt.jsonl`);

async function replay(name: string) {
  const cap = loadCapture(DIR, name);
  const rig = makeRig();
  const clock = rig.clock as FakeClock;
  for (const e of cap.events) clock.at(e.t_ms, () => rig.tracker.ingest({ ...e, session_id: rig.session } as never));
  clock.advance(cap.call!.t_ms);                       // everything that had happened by the moment the agent's tool.call arrived
  const before = rig.hash();
  const res = await rig.gate.submit({ session_id: rig.session, aai_call_id: cap.call!.id, tool: 'add_item', args: cap.call!.args, received_t_ms: cap.call!.t_ms });
  const lines = rig.store.getOrder(rig.session)!.state.lines;
  const out = { name, agentQty: cap.call!.args.quantity as number, res, changed: rig.hash() !== before, lines, waited: res.waited_ms ?? 0 };
  rig.close();
  return out;
}

const STALE_AND_UNRESOLVED = [
  'barge_in-1', 'barge_in-2', 'barge_in-3',
  'late_correction_1500ms-1', 'late_correction_1500ms-2', 'late_correction_1500ms-3',
  'late_correction_900ms-1', 'late_correction_900ms-2',
];
const STALE_BUT_CORRECTION_BEGAN_AFTER_THE_CALL = ['correction_during_hold-1', 'correction_during_hold-2', 'correction_during_hold-3'];
const ALREADY_CORRECT = ['inline_correction-1', 'inline_correction-2', 'inline_correction-3', 'late_correction_400ms-1', 'late_correction_400ms-3', 'late_correction_900ms-3'];
const CLEAN = ['clean_order-1', 'clean_order-2', 'clean_order-3'];

describe.skipIf(!have)('real-capture replay through the real gate (spike A, 21 sessions)', () => {
  it('the 8 stale first calls whose correction was still unresolved at the call are ALL held QTY_MISMATCH(3), inside the 4 s budget, order untouched', async () => {
    const waits: number[] = [];
    for (const n of STALE_AND_UNRESOLVED) {
      const r = await replay(n);
      expect(r.agentQty, n).toBe(2);
      expect(r.res, `${n}: ${JSON.stringify(r.res)}`).toMatchObject({ verdict: 'HOLD', code: 'QTY_MISMATCH', repair: { evidenced_value: '3' } });
      expect(r.changed, `${n}: a held call must not change the order`).toBe(false);
      expect(r.lines, n).toEqual([]);
      expect(r.waited, n).toBeLessThan(4000);
      waits.push(r.waited);
    }
    console.log(`gate waited (ms) on the 8 held real calls: min ${Math.round(Math.min(...waits))}, p50 ${Math.round([...waits].sort((a, b) => a - b)[3]!)}, max ${Math.round(Math.max(...waits))}`);
  });

  it('calls that ALREADY carry the corrected quantity are ALLOWED and commit exactly 3 (no false holds on the real corpus)', async () => {
    for (const n of ALREADY_CORRECT) {
      const r = await replay(n);
      expect(r.agentQty, n).toBe(3);
      expect(r.res.verdict, `${n}: ${JSON.stringify(r.res)}`).toBe('ALLOW');
      expect(r.lines, n).toEqual([{ item_id: 'burger', quantity: 3, modifiers: [] }]);
    }
  });

  it('REAL AGENT HALLUCINATION the spike analysis had missed: "No, wait, make it 3" became add_item(burger x3, [no_onions, no_pickles, no_tomato, no_lettuce, no_sauce]); the gate holds it (true positive, not a false hold)', async () => {
    const r = await replay('late_correction_400ms-2');
    expect(r.agentQty).toBe(3);                                  // the quantity was right, which is why a quantity-only analysis counted it as correct
    expect(r.res).toMatchObject({ verdict: 'HOLD', code: 'REMOVAL_MISMATCH' });
    expect(r.changed).toBe(false);
    expect(r.lines).toEqual([]);                                 // five unrequested removals never reach the kitchen
  });

  it('REAL AGENT HALLUCINATION: add_item(coke, [size_large]) after "2 burgers and a Coke" is held MODIFIER_MISMATCH (customer never asked for large)', async () => {
    const cap = loadCapture(DIR, 'clean_order-2');
    const call = cap.primary.find((l: any) => l.dir === 'in' && l.msg.type === 'tool.call' && l.msg.arguments?.item_id === 'coke' && l.msg.arguments.modifiers?.includes('size_large'))!;
    const rig = makeRig();
    const clock = rig.clock as FakeClock;
    for (const e of cap.events) clock.at(e.t_ms, () => rig.tracker.ingest({ ...e, session_id: rig.session } as never));
    clock.advance(call.t_ms);
    const before = rig.hash();
    const res = await rig.gate.submit({ session_id: rig.session, aai_call_id: call.msg.call_id, tool: 'add_item', args: call.msg.arguments, received_t_ms: call.t_ms });
    expect(res).toMatchObject({ verdict: 'HOLD', code: 'MODIFIER_MISMATCH' });
    expect(rig.hash()).toBe(before);
    rig.close();
  });

  it('clean orders ("two burgers and a coke") are ALLOWED with no wait', async () => {
    for (const n of CLEAN) {
      const r = await replay(n);
      expect(r.res, n).toMatchObject({ verdict: 'ALLOW', waited_ms: 0 });
    }
  });

  it('INHERENT LIMIT (documented, not hidden): when the customer starts the correction AFTER the agent\'s call, nobody is speaking at decision time, so the gate allows the call; the correction is caught by the NEXT call or by the confirm-time reconciliation', async () => {
    for (const n of STALE_BUT_CORRECTION_BEGAN_AFTER_THE_CALL) {
      const r = await replay(n);
      expect(r.agentQty, n).toBe(2);
      expect(r.res.verdict, `${n}: ${JSON.stringify(r.res)}`).toBe('ALLOW');   // correct at decision time: the customer had only said "two burgers"
      expect(r.lines, n).toEqual([{ item_id: 'burger', quantity: 2, modifiers: [] }]);
    }
  });

  it('replay is deterministic: the same capture gives the same verdict and wait twice', async () => {
    const a = await replay('late_correction_900ms-1');
    const b = await replay('late_correction_900ms-1');
    expect(JSON.stringify([a.res.verdict, (a.res as any).code, a.waited])).toBe(JSON.stringify([b.res.verdict, (b.res as any).code, b.waited]));
  });
});
