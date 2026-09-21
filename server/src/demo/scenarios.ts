// DETERMINISTIC DEMO SCENARIOS (Step 15): the four experiences A-D from the brief, plus the two proof scenarios (`confidence`,
// `dropout`). Prerecorded, checked-in audio (demo/clips, synthetic SAPI voice, no PII) flows through the REAL recorder, local speech
// check, ingest, evidence tracker, gate, committer, drift check and SQLite. The Voice Agent and the "independent" STT are SCRIPTED
// (server/src/demo/scripted.ts), so the same audio + config + fresh DB gives identical verdicts, orders, cases and counters.
// Every result carries `scripted: true`; nothing here is a claim about the live managed agent.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Secret, wavToPcm } from '@tally/agent';
import type { TallyEvent } from '@tally/contract';
import { replayEvidence, stableStringify, type Store } from '@tally/reliability';
import { SessionRuntime, type RuntimeOptions } from '../runtime.js';
import { runAudioReplay } from '../replay-audio.js';
import { ensureBaseline } from '../bootstrap.js';
import { sleep, startScriptedAgent, startScriptedStt, until, type ScriptedAgent, type ScriptedStt } from './scripted.js';

export const SCENARIOS = ['A', 'B', 'C', 'D', 'confidence', 'dropout'] as const;
export type ScenarioName = (typeof SCENARIOS)[number];
export const SCENARIO_LABELS: Record<ScenarioName, string> = {
  A: 'A · clean order (two burgers and a coke)',
  B: 'B · recover (interrupt: "no wait, make it three")',
  C: 'C · replay B\'s case against config v2',
  D: 'D · learn (the same correction pattern, three times)',
  confidence: 'confidence · a misheard quantity is held (protects the confidence check)',
  dropout: 'dropout · the evidence stream dies mid-hold (fail closed)',
};
export const DEMO_BANNER = 'DETERMINISTIC DEMO: prerecorded audio through the real pipeline; the agent and the independent transcripts are scripted (not the live agent)';

const CLIPS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../demo/clips');
const clipCache = new Map<string, Uint8Array>();
export const clipPcm = (name: string, dir = CLIPS_DIR): Uint8Array => {
  const k = `${dir}/${name}`;
  if (!clipCache.has(k)) clipCache.set(k, wavToPcm(new Uint8Array(readFileSync(join(dir, `${name}.wav`)))));
  return clipCache.get(k)!;
};
/** 100 ms of audible (RMS >> 100) agent audio: makes a reply count as SPEAKING, so barge-in derivation and first-audio work */
const TONE_B64 = (() => {
  const n = 2400; const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * 220 * i) / 24000)), i * 2);
  return b.toString('base64');
})();

export interface DemoOptions {
  store: Store;
  audioDir: string;
  clipsDir?: string;
  /** gating parameters etc. (the active config's, from the server; defaults otherwise) */
  runtime?: Partial<RuntimeOptions>;
  /** called with each session the moment it starts, so a dashboard can attach to its live stream */
  onSession?: (rt: SessionRuntime) => void;
  onEvent?: (e: TallyEvent) => void;
  onStep?: (msg: string) => void;
}

export interface SessionSummary {
  intent: { items: { item_id: string; quantity: number; modifiers?: string[] }[]; pickup?: string };
  verdicts: { tool: string; args: unknown; verdict: 'ALLOW' | 'HOLD'; code?: string; waited: boolean; repaired?: boolean; noop?: boolean }[];
  repairs: string[];
  agent_says: string[];
  barge_ins: number;
  final_order: { lines: unknown[]; total_cents: number; status: string } | null;
  cases: { pattern_key: string; conflict_type: string; resolution: string; tag: string }[];
}
export interface ScenarioResult {
  scenario: ScenarioName; label: string; deterministic: true; scripted: { agent: true; transcripts: true }; banner: string;
  sessions: SessionSummary[];
  /** scenario C only */
  replay?: { case_pattern: string; evidence: { version: string; label: string; result: string }[]; audio: { version: string; label: string; k: number; passed: number } };
  counters: { cases: number; regression_candidates: number; regressions: number };
}

type Captured = { verdicts: SessionSummary['verdicts']; repairs: string[]; says: string[]; barge: number };

class World {
  constructor(readonly agent: ScriptedAgent, readonly stt: ScriptedStt, readonly o: DemoOptions, readonly cap: Map<string, Captured>, readonly sessionIds: string[]) {}
  static async open(o: DemoOptions): Promise<World> {
    const cap = new Map<string, Captured>();
    const w = new World(await startScriptedAgent(), await startScriptedStt(), { ...o }, cap, []);
    return w;
  }
  async close(): Promise<void> { await this.agent.close(); await this.stt.close(); }

  async session(intent: SessionSummary['intent'], mode: 'demo' | 'replay' = 'demo'): Promise<Driver> {
    const o = this.o;
    const rt = await SessionRuntime.start({
      // the key is never used (loopback scripted servers); built at runtime so no key-shaped literal exists in the source
      agentConfig: { apiKey: new Secret(['demo', 'offline', 'scripted'].join('-')), wsUrl: this.agent.url, restUrl: 'http://127.0.0.1:1' },
      store: o.store, audioDir: o.audioDir, mode, stt: { url: this.stt.url },
      onEvent: (e) => { this.capture(e); o.onEvent?.(e); }, ...o.runtime,
    });
    this.sessionIds.push(rt.session_id);
    if (mode === 'demo') o.store.setIntent(rt.session_id, intent);
    o.onSession?.(rt);
    return new Driver(this, rt, intent);
  }

  private capture(e: TallyEvent): void {
    let c = this.cap.get(e.session_id);
    if (!c) { c = { verdicts: [], repairs: [], says: [], barge: 0 }; this.cap.set(e.session_id, c); }
    if (e.kind === 'verdict') c.verdicts.push({ tool: e.tool, args: e.args, verdict: e.verdict, code: e.code, waited: (e.waited_ms ?? 0) > 100, ...(e.repaired ? { repaired: true } : {}), ...(e.noop ? { noop: true } : {}) });
    else if (e.kind === 'repair' && e.outcome !== 'resolved' && e.ask_text) c.repairs.push(`${e.outcome}: ${e.ask_text}`);
    else if (e.kind === 'transcript_agent' && e.text && !e.interrupted) c.says.push(e.text);
    else if (e.kind === 'barge_in') c.barge++;
  }
}

class Driver {
  private turn = 0; private replies = 0;
  constructor(private readonly w: World, readonly rt: SessionRuntime, private readonly intent: SessionSummary['intent']) {}
  private static n = 0;

  private pcm(name: string) { return clipPcm(name, this.w.o.clipsDir); }

  /** the customer speaks a prerecorded clip through the REAL audio path; the scripted independent stream acknowledges, then finalises it */
  async customer(clip: string, text: string, o: { conf?: number; ackMs?: number; finalMs?: number; partial?: string; midCalls?: { atMs: number; tool: string; args: unknown }[] } = {}): Promise<any[]> {
    const order = this.turn++;
    const audio = this.rt.sendPcm(this.pcm(clip));
    const ack = o.ackMs ?? 500;
    setTimeout(() => this.w.stt.speechStarted(), ack);
    if (o.partial) setTimeout(() => this.w.stt.partial(o.partial!, order), ack + 500);
    const mids = (o.midCalls ?? []).map((c) => new Promise<any>((res) => setTimeout(() => res(this.call(c.tool, c.args)), c.atMs)));
    await audio;
    await sleep(o.finalMs ?? 900);
    this.w.stt.final(text, order, o.conf);
    return Promise.all(mids);
  }

  /** the scripted agent decides to call a tool; returns the tool.result Tally answered with */
  async call(tool: string, args: unknown): Promise<any> {
    const id = `demo-call-${++Driver.n}`;
    this.w.agent.push({ type: 'tool.call', call_id: id, name: tool, arguments: args });
    return this.w.agent.result(id);
  }

  /** the scripted agent speaks a complete reply */
  async says(text: string): Promise<void> {
    const id = `demo-reply-${++this.replies}`;
    this.w.agent.push({ type: 'reply.started', reply_id: id });
    this.w.agent.push({ type: 'reply.audio', data: TONE_B64 });
    this.w.agent.push({ type: 'transcript.agent', text, reply_id: id });
    this.w.agent.push({ type: 'reply.done', status: 'completed', reply_id: id });
    await sleep(200);
  }
  /** the agent starts speaking (audible) and keeps going until `interruptedBy` */
  begins(): void {
    const id = `demo-reply-${++this.replies}`;
    this.w.agent.push({ type: 'reply.started', reply_id: id });
    this.w.agent.push({ type: 'reply.audio', data: TONE_B64 });
    this.pendingReply = id;
  }
  private pendingReply = '';
  /** the customer's speech begins over the agent's audible reply and the reply is cut off */
  interrupted(spoken: string): void {
    this.w.agent.push({ type: 'input.speech.started' });
    this.w.agent.push({ type: 'transcript.agent', text: spoken, reply_id: this.pendingReply, interrupted: true });
    this.w.agent.push({ type: 'reply.done', status: 'interrupted', reply_id: this.pendingReply });
  }

  ask(result: any): string {
    const m = /"([^"]+)"/.exec(String(result?.instruction ?? ''));
    return m?.[1] ?? 'Sorry, could you say that again?';
  }

  async finish(): Promise<SessionSummary> {
    await sleep(250);
    await this.rt.end();
    const cap = this.w.cap.get(this.rt.session_id) ?? { verdicts: [], repairs: [], says: [], barge: 0 };
    const o = this.w.o.store.getOrder(this.rt.session_id);
    const cases = this.w.o.store.listCases({ session_id: this.rt.session_id }).map((c) => ({ pattern_key: c.pattern_key, conflict_type: c.conflict_type, resolution: this.w.o.store.getCase(c.id)!.resolution, tag: this.w.o.store.getCase(c.id)!.tag }));
    return {
      intent: this.intent, verdicts: cap.verdicts, repairs: cap.repairs, agent_says: cap.says, barge_ins: cap.barge,
      final_order: o ? { lines: o.state.lines, total_cents: o.total_cents, status: o.state.status } : null, cases,
    };
  }
}

const item = (item_id: string, quantity: number, modifiers: string[] = []) => ({ item_id, quantity, modifiers });
const burger = (q: number) => item('burger', q);

async function scenarioA(w: World): Promise<SessionSummary> {
  const d = await w.session({ items: [{ item_id: 'burger', quantity: 2 }, { item_id: 'coke', quantity: 1 }], pickup: 'ASAP' });
  await d.customer('clean', 'Two burgers and a coke.');
  await d.call('add_item', burger(2));
  await d.call('add_item', item('coke', 1));
  await d.says('Got it, two classic burgers and a coke.');
  await d.customer('pickup_asap', "That's all. Pickup as soon as possible.");
  const done = await d.call('confirm_order', { pickup_time: 'ASAP' });
  await d.says(`Your order is confirmed. That's ${done.total}.`);
  return d.finish();
}

/** B: the customer interrupts the agent mid-reply with the correction; the agent's stale call is HELD while the gate WAITS for the independent stream */
async function scenarioB(w: World): Promise<SessionSummary> {
  const d = await w.session({ items: [{ item_id: 'burger', quantity: 3 }] });
  await d.customer('two_burgers', 'Two burgers.');
  d.begins();                                                                            // the agent starts to answer ("Sure, two ...")
  const correction = d.customer('no_wait_three', 'No, wait, make it three.', { midCalls: [{ atMs: 1300, tool: 'add_item', args: burger(2) }] });
  await sleep(350);
  d.interrupted('Sure, two burg');                                                       // ...and is cut off by the customer: a derived barge-in
  const [held] = await correction;                                                       // the stale call waited on independent evidence, then HELD
  await d.says(d.ask(held));
  await d.customer('yes_three', 'Yes, three.');
  const ok = await d.call('add_item', burger(3));
  await d.says(`Got it, three classic burgers. That's ${ok.total}.`);
  return d.finish();
}

async function correctionOnce(w: World): Promise<SessionSummary> {
  const d = await w.session({ items: [{ item_id: 'burger', quantity: 3 }] });
  const [held] = await d.customer('inline_corr', 'Two burgers, no wait, make it three.', { midCalls: [{ atMs: 1200, tool: 'add_item', args: burger(2) }] });
  await d.says(d.ask(held));
  await d.customer('yes_three', 'Yes, three.');
  const ok = await d.call('add_item', burger(3));
  await d.says(`Got it, three classic burgers. That's ${ok.total}.`);
  return d.finish();
}

async function scenarioConfidence(w: World): Promise<SessionSummary> {
  const d = await w.session({ items: [{ item_id: 'burger', quantity: 3 }] });
  await d.customer('two_burgers', 'Two burgers.', { conf: 0.4 });                          // the independent stream is only 40% sure of its words
  const held = await d.call('add_item', burger(2));                                        // the agent's call may be right, but Tally cannot confirm it
  await d.says(d.ask(held));
  await d.customer('no_wait_three_b', 'Three burgers.');
  const ok = await d.call('add_item', burger(3));
  await d.says(`Got it, three classic burgers. That's ${ok.total}.`);
  return d.finish();
}

async function scenarioDropout(w: World): Promise<SessionSummary> {
  const d = await w.session({ items: [] });
  setTimeout(() => w.stt.drop(), 1300);                                                    // the evidence stream dies while the gate is waiting
  const [held] = await d.customer('two_burgers', 'Two burgers.', { ackMs: 400, midCalls: [{ atMs: 900, tool: 'add_item', args: burger(2) }] });
  await d.says(d.ask(held));
  return d.finish();
}

async function scenarioC(w: World, o: DemoOptions, say: (m: string) => void): Promise<{ sessions: SessionSummary[]; replay: NonNullable<ScenarioResult['replay']> }> {
  const { store } = o;
  const sessions: SessionSummary[] = [];
  let target = store.listCases().find((c) => c.pattern_key.includes('correction|after_item') && store.getCase(c.id)!.resolution === 'resolved');
  if (!target) { say('no case from B yet: playing B first'); sessions.push(await scenarioB(w)); target = store.listCases().find((c) => c.pattern_key.includes('correction|after_item') && store.getCase(c.id)!.resolution === 'resolved'); }
  if (!target) throw new Error('scenario C needs a resolved case from B');
  ensureBaseline(store);
  if (!store.getConfig('v2')) store.createConfig({ version: 'v2', prompt_text: store.activeConfig()!.prompt_text, tool_schema_json: store.activeConfig()!.tool_schema_json, gating_params: { evidenceWaitMaxMs: 3500 }, parent_version: store.activeConfig()!.version, actor: 'operator' });
  const evidence: { version: string; label: string; result: string }[] = [];
  for (const v of ['v1', 'v2']) {
    const cfg = store.getConfig(v)!;
    say(`evidence-tier replay against ${v}`);
    const r = await replayEvidence(store, target.id, { gate: { evidenceWaitMaxMs: cfg.gating_params.evidenceWaitMaxMs, minWordConfidence: cfg.gating_params.minWordConfidence }, sttStallMs: cfg.gating_params.sttStallMs, configVersion: v });
    evidence.push({ version: v, label: r.label, result: r.result });
  }
  say('audio-tier replay against v2 (k=3, scripted agent)');
  const c = store.getCase(target.id)!;
  const audioMs = readFileSync(c.audio_pointer).byteLength / 48;
  const audio = await runAudioReplay({
    store, caseId: target.id, k: 3, configVersion: 'v2', settleMs: 2500,
    startRuntime: async () => {
      const d = await w.session({ items: [] }, 'replay');
      void (async () => {                                                                   // the scripted agent behaves as the fixed build should
        await sleep(audioMs + 300);
        w.stt.speechStarted(); w.stt.final('Two burgers.', 0);
        await sleep(300); w.stt.speechStarted(); w.stt.final('No, wait, make it three.', 1);
        await sleep(300);
        await d.call('add_item', burger(3)).catch(() => undefined);
      })();
      return d.rt;
    },
  });
  return { sessions, replay: { case_pattern: target.pattern_key, evidence, audio: { version: 'v2', label: audio.label, k: audio.k, passed: audio.passed } } };
}

export async function runScenario(name: ScenarioName, o: DemoOptions): Promise<ScenarioResult> {
  const say = (m: string) => o.onStep?.(m);
  const w = await World.open(o);
  try {
    ensureBaseline(o.store);
    say(`scenario ${name}: ${SCENARIO_LABELS[name]}`);
    let sessions: SessionSummary[] = []; let replay: ScenarioResult['replay'];
    if (name === 'A') sessions = [await scenarioA(w)];
    else if (name === 'B') sessions = [await scenarioB(w)];
    else if (name === 'D') { for (let i = 1; i <= 3; i++) { say(`D · correction ${i} of 3`); sessions.push(await correctionOnce(w)); } }
    else if (name === 'confidence') sessions = [await scenarioConfidence(w)];
    else if (name === 'dropout') sessions = [await scenarioDropout(w)];
    else { const r = await scenarioC(w, o, say); sessions = r.sessions; replay = r.replay; }
    const cs = o.store.caseCounts();
    return { scenario: name, label: SCENARIO_LABELS[name], deterministic: true, scripted: { agent: true, transcripts: true }, banner: DEMO_BANNER, sessions, ...(replay ? { replay } : {}), counters: { cases: cs.cases, regression_candidates: cs.candidates, regressions: cs.regressions } };
  } finally { await w.close(); }
}

export async function runAll(o: DemoOptions, names: readonly ScenarioName[] = ['A', 'B', 'C', 'D']): Promise<ScenarioResult[]> {
  const out: ScenarioResult[] = [];
  for (const n of names) out.push(await runScenario(n, o));
  return out;
}

/** The comparable form of a run: no timestamps, ids or wall-clock durations. Two runs from a fresh DB must produce identical strings. */
export function normalise(results: readonly ScenarioResult[]): string {
  return stableStringify(results.map((r) => ({ ...r, sessions: r.sessions.map((s) => ({ ...s })) })));
}
export { until };
