// npm run spike:g5 [-- --scenarios=a,b --repeat=3 --analyze-only]
// Live capture against the real AssemblyAI Voice Agent API (needs ASSEMBLYAI_API_KEY in the environment).
// Writes raw evidence to fixtures/aai-events/<scenario>-<n>.jsonl and a generated report to docs/spike-g5.generated.md.
// SPIKE ONLY: uses the pass-through stub (no validation). Never wired to live/demo paths.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GREETING, buildSystemPrompt, menuKeyterms } from '../prompt.js';
import { loadAgentConfig } from '../config.js';
import { AgentSession, type RawRecord } from '../session.js';
import { silence, wavToPcm } from '../audio.js';
import { analyseRun, judge, type RawLine } from './analyze.js';
import { SCENARIOS, type Scenario } from './scenarios.js';
import { makeSpikePassThrough } from './stub-handler.js';
import { SttStream, type SttRaw } from '../../../stt/src/index.js';

const OUT = process.argv.find((a) => a.startsWith('--out='))?.split('=')[1] ?? 'fixtures/aai-events';
const CLIPS = 'fixtures/audio/spike';
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
const has = (k: string) => process.argv.includes(`--${k}`);

async function runScenario(sc: Scenario, n: number): Promise<string> {
  const config = loadAgentConfig();
  const withStt = has('stt2');
  const interactive = arg('mode') === 'interactive'; // SPIKE B diagnostic only (D-19): never a gating design
  const sttLines: SttRaw[] = [];
  let stt: SttStream | undefined;
  const lines: RawLine[] = [];
  let session!: AgentSession;
  const stub = makeSpikePassThrough({ delayMs: sc.stubDelayMs, now: () => session.elapsedMs() });
  session = new AgentSession({
    config, tallySessionId: AgentSession.newId(), mode: 'live', configVersion: 'v1-spike',
    systemPrompt: buildSystemPrompt(), greeting: GREETING, keyterms: menuKeyterms(),
    handler: stub.handler, onRaw: (r: RawRecord) => lines.push(r),
    onInputAudio: (pcm) => stt?.feed(pcm),
    ...(interactive ? { spikeToolMode: 'interactive' as const } : {}),
  });
  const mark = (label: string) => lines.push({ dir: 'marker', label, wall_ms: Date.now(), t_ms: session.elapsedMs(), audio_offset_ms: session.events.at(-1)?.audio_offset_ms ?? 0 });
  const clip = (name: string) => wavToPcm(new Uint8Array(readFileSync(join(CLIPS, `${name}.wav`))));

  if (withStt) {
    // independent stream shares the session clock so timelines align; opened first so it hears the same audio from t=0
    stt = new SttStream({ apiKey: config.apiKey, clock: () => session.elapsedMs(), onRaw: (r) => sttLines.push(r) });
    await stt.connect();
  }
  await session.connect();
  mark('connected');
  // let the greeting play out while streaming silence, so the scenario starts from a settled state
  const streamUntil = async (pred: () => boolean, timeoutMs: number) => {
    const t = performance.now();
    while (!pred() && performance.now() - t < timeoutMs) await session.sendPcm(silence(100));
    return pred();
  };
  const seen = (kind: string) => { const from = session.events.length; return () => session.events.slice(from).some((e) => e.kind === kind); };
  // Wait for the greeting reply to finish (reply_done) so the scenario starts from a settled state (run 1 bug: it
  // started 170 ms after connect and interrupted the greeting in every scenario).
  const greetingDone = await streamUntil(seen('reply_done'), 15000);
  mark(greetingDone ? 'greeting_done' : 'timeout:greeting_done');
  await session.sendPcm(silence(600));

  try {
    for (const step of sc.steps) {
      if ('say' in step) { if (step.marker) mark(step.marker); mark(`say:${step.say}`); await session.sendPcm(clip(step.say)); mark(`end:${step.say}`); }
      else if ('silence' in step) await session.sendPcm(silence(step.silence));
      else if ('untilAgentSpeech' in step) {
        const from = lines.length;
        const ok = await streamUntil(() => lines.slice(from).some((l) => l.dir === 'in' && (l.msg as any)?.type === 'reply.audio' && ((l.msg as any).rms ?? 0) > 100), step.untilAgentSpeech);
        if (!ok) mark('timeout:untilAgentSpeech');
      }
      else if ('until' in step) {
        const kindMap = { reply_started: 'reply_started', tool_call: 'tool_call', reply_done: 'reply_done' } as const;
        const ok = await streamUntil(seen(kindMap[step.until]), step.timeoutMs);
        if (!ok) mark(`timeout:${step.until}`);
      } else {
        let count = -1; let stableSince = performance.now(); const t0 = performance.now();
        while (performance.now() - t0 < step.maxMs) {
          await session.sendPcm(silence(200));
          if (session.events.length !== count) { count = session.events.length; stableSince = performance.now(); }
          else if (performance.now() - stableSince >= step.quiet) break;
        }
      }
    }
  } finally {
    await session.end();
    await stt?.terminate();
  }
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, `${sc.name}-${n}.jsonl`);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  if (withStt) writeFileSync(file.replace(/\.jsonl$/, '.stt.jsonl'), sttLines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

function analyseAll(): string {
  const files = readdirSync(OUT).filter((f) => f.endsWith('.jsonl') && !f.endsWith('.stt.jsonl'));
  const runs = files.map((f) => analyseRun(f.replace(/-\d+\.jsonl$/, ''), readFileSync(join(OUT, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as RawLine)));
  const report = judge(runs);
  const sigs = [...new Map(runs.map((r) => [`${r.scenario}`, r.ordering_signature.join(' → ')])).entries()];
  const md = [
    '# Spike G5: generated analysis (machine output; a human verdict lives in docs/spike-g5.md)',
    `Generated ${new Date().toISOString()} from ${files.length} captured run(s).`,
    `\n## Machine verdict: **${report.verdict}**${report.suggested_buffer_ms ? ` (suggested GATE_BUFFER_MS=${report.suggested_buffer_ms})` : ''}`,
    ...report.reasons.map((r) => `- ${r}`),
    '\n## Stats\n```json\n' + JSON.stringify(report.stats, null, 2) + '\n```',
    '\n## Event ordering per scenario (client-stamped; audio/delta runs collapsed)',
    ...sigs.map(([s, o]) => `- **${s}**: ${o}`),
    '\n## Per-call facts\n```json\n' + JSON.stringify(runs.map((r) => ({ scenario: r.scenario, calls: r.calls, corrections: r.corrections, barge: r.barge })), null, 1) + '\n```',
  ].join('\n');
  writeFileSync('docs/spike-g5.generated.md', md);
  return `${report.verdict}: ${report.reasons.join(' | ')}`;
}

async function main() {
  if (!has('analyze-only')) {
    const only = arg('scenarios')?.split(',');
    const repeat = Number(arg('repeat') ?? 2);
    for (const sc of SCENARIOS.filter((s) => !only || only.includes(s.name))) {
      for (let n = 1; n <= repeat; n++) {
        process.stdout.write(`run ${sc.name} #${n} … `);
        try { console.log(await runScenario(sc, n)); } catch (e) { console.log(`FAILED: ${(e as Error).message}`); }
      }
    }
  }
  if (OUT === 'fixtures/aai-events') console.log('\n' + analyseAll());
  else console.log(`\ncaptured into ${OUT}; analyse with: npx tsx scripts/spike-a-summary.ts ${OUT}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
