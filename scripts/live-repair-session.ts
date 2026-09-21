// LIVE REPAIR VALIDATION (Step 6 condition 2), automated form.
//   npx tsx --env-file-if-exists=.env scripts/live-repair-session.ts [s1|s2|s3|all]
//
// WHAT THIS IS: the REAL managed Voice Agent and the REAL streaming STT, driven through the real SessionRuntime (recorder, local speech check,
// gate, committer, drift check) exactly as the dashboard mic page drives it. The "customer" is prerecorded SYNTHETIC speech (demo/clips), reacting
// to what the agent actually says. Holds are INDUCED by a fault injected into the evidence extractor (a validation seam, not reachable from HTTP),
// because the managed LLM cannot be made to misread on demand.
// WHAT THIS IS NOT: a human on a microphone, and not a measure of evidence accuracy (real-speech pass). It measures Plane 1's behaviour:
//   A. the real agent speaks the scoped question from a HELD result;
//   B. the customer's answer leads to a re-issued call that Tally re-validates (and, with the fault cleared, commits and resolves the repair);
//   C. after two failed asks the agent hands off (does not keep asking or re-calling for that item);
//   D. a customer speaking OVER the agent's repair question is derived as a barge-in and the repair still completes.
// Output: a transcript of what happened plus PASS / FAIL / NOT-EXERCISED per check. Nothing is retried silently, and the API key is never printed.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAgentConfig } from '../agent/src/config.js';
import { wavToPcm } from '../agent/src/audio.js';
import { initDatabase } from '../db/src/index.js';
import { Store } from '../reliability/src/committer.js';
import { extractEvidence } from '../reliability/src/extractor.js';
import { SessionRuntime } from '../server/src/runtime.js';
import { buildSystemPrompt, GREETING } from '../agent/src/prompt.js';
import type { TallyEvent } from '../contract/src/index.js';

const which = process.argv.slice(2).find((a) => !a.startsWith('-')) ?? 'all';
const OUT = 'data/live-validation';
mkdirSync(OUT, { recursive: true });
const dbPath = join(OUT, `live-${Date.now()}.sqlite`);
initDatabase(dbPath);
const store = new Store(dbPath);
const agentConfig = loadAgentConfig(process.env);
const clip = (n: string) => wavToPcm(new Uint8Array(readFileSync(`demo/clips/${n}.wav`)));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const say = (m: string) => console.log(m);

interface Timeline { t: number; e: TallyEvent }
async function session(fault: { times: number; text: string }, run: (h: Harness) => Promise<void>): Promise<{ events: Timeline[]; checks: Record<string, string> }> {
  const events: Timeline[] = []; const t0 = Date.now();
  let n = 0;
  const rt = await SessionRuntime.start({
    agentConfig, store, audioDir: join(OUT, 'audio'), mode: 'demo', configVersion: 'live-validation', systemPrompt: buildSystemPrompt(),
    onEvent: (e) => events.push({ t: Date.now() - t0, e }),
    gateOverrides: { extract: (finals) => (n++ < fault.times ? extractEvidence([{ text: fault.text }]) : extractEvidence(finals)) },
  });
  const h = new Harness(rt, events);
  const checks: Record<string, string> = {};
  h.checks = checks;
  try { await run(h); } catch (e) { checks.ERROR = `${e instanceof Error ? e.message : String(e)}`; }
  await sleep(1500);
  await rt.end().catch(() => undefined);
  return { events, checks };
}

class Harness {
  checks: Record<string, string> = {};
  constructor(readonly rt: SessionRuntime, readonly events: Timeline[]) {}
  async until(pred: (e: TallyEvent) => boolean, ms: number, from = 0): Promise<TallyEvent | undefined> {
    const start = Date.now();
    for (;;) {
      const hit = this.events.slice(from).find((x) => pred(x.e));
      if (hit) return hit.e;
      if (Date.now() - start > ms) return undefined;
      await sleep(50);
    }
  }
  mark(): number { return this.events.length; }
  async customer(name: string): Promise<void> { await this.rt.sendPcm(clip(name)); }
  verdicts(from = 0) { return this.events.slice(from).map((x) => x.e).filter((e) => e.kind === 'verdict') as Extract<TallyEvent, { kind: 'verdict' }>[]; }
  said(from = 0): string[] { return this.events.slice(from).map((x) => x.e).filter((e) => e.kind === 'transcript_agent').map((e) => (e as { text: string }).text); }
  async greeting(): Promise<void> {
    // never speak over the greeting (that contaminated the first spike run)
    const g = await this.until((e) => e.kind === 'reply_done', 20000);
    if (!g) throw new Error('the agent never finished its greeting');
    await sleep(500);
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const WORDS: Record<string, string> = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7' };
/** the numbers in a sentence as digits, in order ("that's two burgers" and "that's 2 burgers" both give "2") */
const nums = (s: string) => norm(s).split(' ').filter((w) => WORDS[w] !== undefined || /^\d+$/.test(w)).map((w) => WORDS[w] ?? w).join(',');
/** verbatim / paraphrase (same numbers) / ALTERED (the agent changed a number Tally gave it) */
function fidelity(h: Harness, said: string): string {
  const ask = ([...h.events].reverse().map((x) => x.e).find((e) => e.kind === 'repair' && (e as { outcome: string }).outcome === 'asked') as { ask_text?: string } | undefined)?.ask_text ?? '';
  if (!ask) return 'NOT EXERCISED: no ask recorded';
  if (norm(said).includes(norm(ask)) || norm(ask) === norm(said)) return `PASS: verbatim ("${ask}")`;
  const a = new Set(norm(ask).split(' ')); const b = new Set(norm(said).split(' '));
  const jac = [...a].filter((x) => b.has(x)).length / new Set([...a, ...b]).size;
  const w = { tally: nums(ask), agent: nums(said) };
  if (w.tally !== w.agent) return `FAIL: the agent CHANGED the number. Tally: "${ask}" / agent: "${said}"`;
  return `PASS: paraphrase, same numbers (similarity ${jac.toFixed(2)}). Tally: "${ask}" / agent: "${said}"`;
}
/**
 * The synthetic customer answers whenever the agent finishes speaking, up to 3 times, until the agent re-issues the tool call. Real agents
 * often RE-ASK instead of calling straight away (the customer here cannot say a bare "yes"), so the number of rounds is part of the result.
 */
async function answerUntilCall(h: Harness, from: number): Promise<{ before: number; again?: TallyEvent; rounds: number }> {
  let mark = from;
  for (let rounds = 1; rounds <= 3; rounds++) {
    await h.until((e) => e.kind === 'reply_done', 25000, mark);
    await sleep(500);
    const before = h.mark();
    await h.customer('two_burgers');
    const again = await h.until((e) => e.kind === 'verdict', 12000, before);
    if (again) return { before, again, rounds };
    mark = before;
  }
  return { before: h.mark(), rounds: 3 };
}
const results: { session: string; check: string; result: string }[] = [];
const note = (sess: string, check: string, result: string) => { results.push({ session: sess, check, result }); say(`   [${result.startsWith('PASS') ? 'PASS' : result.startsWith('NOT') ? 'NOT EXERCISED' : 'FAIL'}] ${check}: ${result}`); };

// ---- S1: HELD -> the real agent asks -> the customer answers (no interruption) -> re-issued call -> re-validated -> committed, repair resolved
async function s1() {
  say('\n== S1 · scoped question, answer, re-validation (synthetic customer, induced hold)');
  const r = await session({ times: 1, text: 'Three burgers.' }, async (h) => {
    await h.greeting();
    await h.customer('two_burgers');
    const held = await h.until((e) => e.kind === 'verdict' && e.verdict === 'HOLD', 25000);
    if (!held) { note('S1', 'A the agent called add_item and Tally held it', 'NOT EXERCISED: no tool call within 25 s'); return; }
    const afterHold = h.mark();
    const asked = await h.until((e) => e.kind === 'transcript_agent' && /burger/i.test(e.text), 25000, afterHold - 1);
    note('S1', 'A the real agent speaks a question about the disputed item after the HELD result', asked ? `PASS: "${(asked as { text: string }).text}"` : `FAIL: it said ${JSON.stringify(h.said(afterHold))}`);
    if (asked) note('S1', 'A2 fidelity to the instruction it was given', fidelity(h, (asked as { text: string }).text));
    const { before, again, rounds } = await answerUntilCall(h, afterHold);                   // "No: two burgers." each time the agent stops speaking
    if (!again) { note('S1', 'B the answer leads to a re-issued, re-validated call', `FAIL: the agent never called the tool again after ${rounds} answers (it said ${JSON.stringify(h.said(afterHold))})`); return; }
    const v = h.verdicts(before)[0]!;
    note('S1', 'B the answer leads to a re-issued, re-validated call', `PASS after ${rounds} answer(s): re-issued call verdict ${v.verdict}${v.code ? ` ${v.code}` : ''}${v.repaired ? ' (repaired)' : ''}`);
    const resolved = store.allRepairs(h.rt.session_id).some((x) => x.outcome === 'resolved');
    note('S1', 'B the repair resolved only through the re-validated commit', v.verdict === 'ALLOW' && resolved ? `PASS: order ${JSON.stringify(store.getOrder(h.rt.session_id)!.state.lines)}` : v.verdict === 'ALLOW' ? 'FAIL: ALLOW but no resolved repair row' : `NOT EXERCISED: the re-issued call was held again (${v.code}); the agent chose a different quantity`);
  });
  return r;
}

// ---- S2: same, but the customer speaks OVER the agent's audible repair question: a derived barge-in
async function s2() {
  say('\n== S2 · barge-in during the repair question');
  const r = await session({ times: 1, text: 'Three burgers.' }, async (h) => {
    await h.greeting();
    await h.customer('two_burgers');
    const held = await h.until((e) => e.kind === 'verdict' && e.verdict === 'HOLD', 25000);
    if (!held) { note('S2', 'D barge-in during repair', 'NOT EXERCISED: no hold'); return; }
    const afterHold = h.mark();
    const audible = await h.until((e) => e.kind === 'reply_audible', 25000, afterHold - 1);
    if (!audible) { note('S2', 'D barge-in during repair', 'NOT EXERCISED: the agent never became audible'); return; }
    await sleep(350);                                                                       // the agent is mid-question...
    const before = h.mark();
    await h.customer('two_burgers');                                                        // ...and the customer talks over it
    await sleep(1500);
    const barge = h.events.slice(before - 5).map((x) => x.e).find((e) => e.kind === 'barge_in');
    note('S2', 'D a customer speaking over the repair question is derived as a barge-in', barge ? `PASS: derived from ${(barge as { source_event_ids: string[] }).source_event_ids.length} source events, reaction ${Math.round((barge as { reaction_ms?: number }).reaction_ms ?? -1)} ms` : 'FAIL/NOT EXERCISED: no derived barge-in (the agent may have finished speaking before the customer began)');
    const { again: after, rounds } = await answerUntilCall(h, before);
    const resolved = store.allRepairs(h.rt.session_id).some((x) => x.outcome === 'resolved');
    note('S2', 'D the repair still completes after the interruption', after ? `PASS after ${rounds} answer(s): next verdict ${(after as { verdict: string }).verdict}${resolved ? ', repair resolved' : ''}` : `FAIL: no further tool call after the interruption and ${rounds} more answers (agent said ${JSON.stringify(h.said(before))})`);
  });
  return r;
}

// ---- S3: the hold never clears: two asks, then the agent hands off and stops calling the tool for that item
async function s3() {
  say('\n== S3 · two failed asks lead to a hand-off');
  const r = await session({ times: 99, text: 'Seven burgers.' }, async (h) => {
    await h.greeting();
    await h.customer('two_burgers');
    let holds = 0; let asks = 0; let escalated = false; let stuck = '';
    let hv = await h.until((e) => e.kind === 'verdict' && e.verdict === 'HOLD', 30000);
    while (hv && holds < 6) {
      holds++;
      const rep = store.allRepairs(h.rt.session_id);
      escalated = rep.some((x) => x.outcome === 'escalated');
      asks = rep.filter((x) => x.outcome === 'pending').length;
      if (escalated) break;
      const from = h.events.length - 1;
      const r = await answerUntilCall(h, from);                                            // "No: two burgers." until the agent calls again
      if (!r.again) { stuck = `after ${asks} ask(s) the agent did not call the tool again (it said ${JSON.stringify(h.said(from))})`; break; }
      hv = (r.again as { verdict: string }).verdict === 'HOLD' ? r.again : undefined;
    }
    if (!escalated) { note('S3', 'C hand-off after two failed asks', `NOT EXERCISED: holds ${holds}, asks ${asks}, never escalated${stuck ? ` (${stuck})` : ''}`); return; }
    const escIdx = h.events.findIndex((x) => x.e.kind === 'repair' && (x.e as { outcome: string }).outcome === 'escalated');
    const askedBefore = h.events.slice(0, escIdx).filter((x) => x.e.kind === 'repair' && (x.e as { outcome: string }).outcome === 'asked').length;
    const handoff = await h.until((e) => e.kind === 'transcript_agent' && /team member|at pickup/i.test(e.text), 30000, Math.max(0, escIdx));
    note('S3', 'C after two failed asks Tally escalates (data)', askedBefore === 2 ? `PASS: 2 asks, then a hand-off instruction` : `FAIL: ${askedBefore} ask(s) before the hand-off`);
    note('S3', 'C the real agent speaks the hand-off wording (team member / at pickup), not another question', handoff ? `PASS: "${(handoff as { text: string }).text}"` : `FAIL: after the hand-off instruction it said ${JSON.stringify(h.said(escIdx))}`);
    const t1 = h.mark();
    await sleep(8000);
    const more = h.verdicts(t1).filter((v) => v.tool === 'add_item');
    note('S3', 'C the agent does not keep re-calling for that item after the hand-off', more.length === 0 ? 'PASS: no further add_item in 8 s' : `FAIL: ${more.length} further add_item call(s) after the hand-off`);
    const order = store.getOrder(h.rt.session_id)!.state.lines;
    note('S3', 'C the disputed item was never committed', order.length === 0 ? 'PASS: order empty' : `FAIL: order ${JSON.stringify(order)}`);
  });
  return r;
}

const runs: Record<string, () => Promise<{ events: Timeline[]; checks: Record<string, string> }>> = { s1, s2, s3 };
const chosen = which === 'all' ? ['s1', 's2', 's3'] : [which];
say('LIVE REPAIR VALIDATION: real Voice Agent + real streaming STT; synthetic customer voice; holds INDUCED by fault injection.');
const dump: Record<string, unknown> = { started: new Date().toISOString(), note: 'synthetic customer, induced holds, real agent; see scripts/live-repair-session.ts', sessions: {} };
for (const k of chosen) {
  const r = await runs[k]!();
  if (r.checks.ERROR) note(k.toUpperCase(), 'harness', `FAIL: ${r.checks.ERROR}`);
  // keep the transcript-level evidence (no audio, no key): what was said, what was decided
  (dump.sessions as Record<string, unknown>)[k] = r.events.filter((x) => ['transcript_agent', 'evidence_transcript', 'verdict', 'repair', 'barge_in', 'gate_waiting', 'case'].includes(x.e.kind)).map((x) => ({ t_ms: x.t, kind: x.e.kind, ...(x.e.kind === 'transcript_agent' || x.e.kind === 'evidence_transcript' ? { text: (x.e as { text: string }).text } : x.e.kind === 'verdict' ? { tool: (x.e as { tool: string }).tool, verdict: (x.e as { verdict: string }).verdict, code: (x.e as { code?: string }).code } : x.e.kind === 'repair' ? { outcome: (x.e as { outcome: string }).outcome, ask: (x.e as { ask_text?: string }).ask_text } : {}) }));
}
dump.results = results;
writeFileSync(join(OUT, 'last-run.json'), JSON.stringify(dump, null, 2));
say(`\n${results.filter((r) => r.result.startsWith('PASS')).length} pass, ${results.filter((r) => r.result.startsWith('FAIL')).length} fail, ${results.filter((r) => r.result.startsWith('NOT')).length} not exercised`);
store.close();
void GREETING;
