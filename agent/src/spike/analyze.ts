// Spike analysis: turns raw captured JSONL (in/out wire messages + scenario markers, all client-stamped) into the
// event-ordering facts needed for the hold-mode go/no-go (DECISIONS D-16). Pure functions; unit-tested on synthetic data.
import type { RawRecord } from '../session.js';

export interface MarkerLine { dir: 'marker'; label: string; wall_ms: number; t_ms: number; audio_offset_ms: number }
export type RawLine = RawRecord | MarkerLine;

const MUTATING = new Set(['add_item', 'remove_item', 'update_quantity', 'apply_modifier', 'confirm_order']);
const SPEECH_RMS = 100; // PCM16 RMS above this counts as speech; silence frames are ~0
const CUE = /\b(no wait|wait|actually|make (it|that)|scratch that|i mean|instead)\b/i;

interface Msg { t: number; type: string; m: any }
export interface CallFacts {
  call_id: string; tool: string; mutating: boolean; t_call_ms: number;
  hold_ms: number | null;                      // tool.call → our tool.result
  final_before_call: boolean;                  // a transcript.user final for the current turn preceded tool.call
  stopped_to_call_ms: number | null;           // last input.speech.stopped → tool.call
  spoke_before_call: boolean;                  // NON-SILENT agent audio between last speech stop and tool.call
  silent_audio_before_call_ms: number;         // silence-padding audio streamed in that gap (10 ms per chunk)
  loud_audio_before_call_ms: number;
  args: unknown;
  speech_started_during_hold: number;
  finals_during_hold: { text: string; after_call_ms: number; cue: boolean }[];
  finals_after_result: { text: string; after_call_ms: number; cue: boolean }[];
  pause_after_result_ms: number | null;        // our tool.result → first reply.audio
  silence_total_ms: number | null;             // last speech stop → first agent audio after result
}
export interface CorrectionFacts { label: string; t_marker_ms: number; vad_lag_ms: number | null; final_lag_ms: number | null; call_arrived_after_correction_began: boolean; blind: boolean; call_id: string | null }
export interface BargeFacts { kind: 'interrupt' | 'backchannel'; speech_started_t: number; reply_done_t: number | null; reaction_ms: number | null }
export interface RunAnalysis {
  scenario: string;
  ordering_signature: string[];                // compact wire-type sequence (audio/delta runs collapsed)
  calls: CallFacts[];
  corrections: CorrectionFacts[];
  barge: BargeFacts[];
  wire_types_seen: string[];
}

function messages(lines: RawLine[]): { ins: Msg[]; outs: Msg[]; markers: MarkerLine[] } {
  const ins: Msg[] = []; const outs: Msg[] = []; const markers: MarkerLine[] = [];
  for (const l of lines) {
    if (l.dir === 'marker') markers.push(l);
    else {
      const m: any = l.msg;
      (l.dir === 'in' ? ins : outs).push({ t: l.t_ms, type: typeof m?.type === 'string' ? m.type : '?', m });
    }
  }
  return { ins, outs, markers };
}

const last = <T>(a: T[]): T | undefined => a[a.length - 1];

export function analyseRun(scenario: string, lines: RawLine[]): RunAnalysis {
  const { ins, outs, markers } = messages(lines);

  const sig: string[] = [];
  for (const m of ins) {
    const tag = m.type;
    if (['reply.audio', 'transcript.agent.delta', 'transcript.user.delta'].includes(tag) && last(sig) === `${tag}*`) continue;
    sig.push(['reply.audio', 'transcript.agent.delta', 'transcript.user.delta'].includes(tag) ? `${tag}*` : tag);
  }

  const calls: CallFacts[] = [];
  for (const c of ins.filter((m) => m.type === 'tool.call')) {
    const call_id = String(c.m.call_id);
    const res = outs.find((o) => o.type === 'tool.result' && o.m.call_id === call_id);
    const tRes = res?.t ?? null;
    const stopsBefore = ins.filter((m) => m.type === 'input.speech.stopped' && m.t <= c.t);
    const lastStop = last(stopsBefore);
    const startsBefore = ins.filter((m) => m.type === 'input.speech.started' && m.t <= c.t);
    const lastStart = last(startsBefore);
    const finalsBefore = ins.filter((m) => m.type === 'transcript.user' && m.t <= c.t && (!lastStart || m.t >= lastStart.t));
    // "Spoke" = non-silent agent audio between the end of the user's speech and the tool.call. A reply.started with only
    // silence frames is NOT speech (run-1 finding: the server streams silence while the model decides to call a tool).
    const audioBefore = lastStop ? ins.filter((m) => m.type === 'reply.audio' && m.t > lastStop.t && m.t < c.t) : [];
    const energyKnown = audioBefore.every((m) => typeof m.m.rms === 'number');
    const loud = audioBefore.filter((m) => (m.m.rms ?? 0) > SPEECH_RMS).length;
    const spoke = energyKnown ? loud > 0 : (lastStop ? ins.some((m) => m.type === 'reply.started' && m.t > lastStop.t && m.t < c.t) : false);
    const inHold = (m: Msg) => m.t > c.t && (tRes === null || m.t <= tRes);
    const finalInfo = (m: Msg) => ({ text: String(m.m.text ?? ''), after_call_ms: m.t - c.t, cue: CUE.test(String(m.m.text ?? '')) });
    const audioAfter = tRes === null ? undefined : ins.find((m) => m.type === 'reply.audio' && m.t > tRes);
    calls.push({
      call_id, tool: String(c.m.name), mutating: MUTATING.has(String(c.m.name)), t_call_ms: c.t,
      hold_ms: tRes === null ? null : tRes - c.t,
      final_before_call: finalsBefore.length > 0,
      stopped_to_call_ms: lastStop ? c.t - lastStop.t : null,
      spoke_before_call: spoke,
      silent_audio_before_call_ms: (audioBefore.length - loud) * 10,
      loud_audio_before_call_ms: loud * 10,
      args: c.m.arguments,
      speech_started_during_hold: ins.filter((m) => m.type === 'input.speech.started' && inHold(m)).length,
      finals_during_hold: ins.filter((m) => m.type === 'transcript.user' && inHold(m)).map(finalInfo),
      finals_after_result: tRes === null ? [] : ins.filter((m) => m.type === 'transcript.user' && m.t > tRes).map(finalInfo),
      pause_after_result_ms: audioAfter && tRes !== null ? audioAfter.t - tRes : null,
      silence_total_ms: audioAfter && lastStop ? audioAfter.t - lastStop.t : null,
    });
  }

  const corrections: CorrectionFacts[] = markers.filter((m) => m.label.startsWith('correction:')).map((mk) => {
    const started = ins.find((m) => m.type === 'input.speech.started' && m.t >= mk.t_ms - 50);
    const fin = ins.find((m) => m.type === 'transcript.user' && m.t > mk.t_ms);
    // The first tool.call that arrived after the correction audio began. A call that came BEFORE the correction was
    // already committed on earlier evidence; the next call's re-validation handles it, so it is not a gating blind spot.
    const call = calls.filter((c) => c.t_call_ms >= mk.t_ms).sort((a, b) => a.t_call_ms - b.t_call_ms)[0];
    // "blind": the correction audio was already being sent when that tool.call arrived, yet no speech signal had fired.
    const blind = !!call && (!started || started.t > call.t_call_ms);
    return { label: mk.label, t_marker_ms: mk.t_ms, vad_lag_ms: started ? started.t - mk.t_ms : null, final_lag_ms: fin ? fin.t - mk.t_ms : null, call_arrived_after_correction_began: !!call, blind, call_id: call?.call_id ?? null };
  });

  const barge: BargeFacts[] = [];
  for (const s of ins.filter((m) => m.type === 'input.speech.started')) {
    const rs = last(ins.filter((m) => m.type === 'reply.started' && m.t < s.t));
    if (!rs) continue;
    const doneAfterRs = ins.find((m) => m.type === 'reply.done' && m.t > rs.t);
    if (doneAfterRs && doneAfterRs.t < s.t) continue; // reply finished before the speech began: not in flight
    // Only a reply that was audibly speaking counts (run 1: hold-mode replies stream silence, and user speech over silence is not a barge-in).
    const audio = ins.filter((m) => m.type === 'reply.audio' && m.t > rs.t && m.t < s.t);
    const audible = audio.some((m) => (m.m.rms ?? 0) > SPEECH_RMS) || (audio.length > 0 && audio.some((m) => typeof m.m.rms !== 'number'));
    if (doneAfterRs && audible) {
      barge.push({ kind: doneAfterRs.m.status === 'interrupted' ? 'interrupt' : 'backchannel', speech_started_t: s.t, reply_done_t: doneAfterRs.t, reaction_ms: doneAfterRs.m.status === 'interrupted' ? doneAfterRs.t - s.t : null });
    }
  }
  return { scenario, ordering_signature: sig, calls, corrections, barge, wire_types_seen: [...new Set(ins.map((m) => m.type))].sort() };
}

const pct = (xs: number[], p: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]!;
};

export type SpikeVerdict = 'PASS' | 'PASS_WITH_BUFFER' | 'FAIL' | 'INCONCLUSIVE';
export interface SpikeReport {
  verdict: SpikeVerdict;
  suggested_buffer_ms: number | null;
  reasons: string[];
  stats: Record<string, unknown>;
}

/** Machine verdict from the rules in DECISIONS D-16. A human still reads the data before signing off. */
export function judge(runs: RunAnalysis[]): SpikeReport {
  const reasons: string[] = [];
  const calls = runs.flatMap((r) => r.calls);
  const mut = calls.filter((c) => c.mutating);
  const corrections = runs.flatMap((r) => r.corrections);
  const barge = runs.flatMap((r) => r.barge);

  if (mut.length === 0) return { verdict: 'INCONCLUSIVE', suggested_buffer_ms: null, reasons: ['no mutating tool calls observed: nothing to judge'], stats: {} };

  let fail = false;
  const spoke = mut.filter((c) => c.spoke_before_call);
  if (spoke.length) { fail = true; reasons.push(`H1 FAIL: agent spoke before ${spoke.length}/${mut.length} mutating tool.call(s): hold mode does not keep the agent silent, so a confirmation can precede validation`); }
  else reasons.push(`H1 ok: agent silent before all ${mut.length} mutating tool.call(s)`);

  const noSignal = runs.filter((r) => r.scenario.includes('during_hold')).flatMap((r) => r.calls).filter((c) => c.mutating && c.speech_started_during_hold === 0 && c.finals_during_hold.length === 0 && c.finals_after_result.length > 0);
  if (noSignal.length) { fail = true; reasons.push(`H4 FAIL: ${noSignal.length} correction(s) spoken during hold produced no speech signal until after tool.result was due: gate would be blind`); }

  const blind = corrections.filter((c) => c.blind);
  const lags = corrections.map((c) => c.vad_lag_ms).filter((x): x is number => x !== null);
  let suggested: number | null = null;
  if (blind.length) {
    suggested = Math.ceil(((pct(blind.map((c) => c.vad_lag_ms ?? 0), 0.95) ?? 0) + 200) / 50) * 50;
    reasons.push(`H3 BUFFER: ${blind.length}/${corrections.length} correction(s) were being spoken when tool.call arrived but their speech signal arrived after it; suggested GATE_BUFFER_MS=${suggested}`);
  } else reasons.push(`H3 ok: ${corrections.length} correction(s) observed, none blind at tool.call`);

  const late = mut.flatMap((c) => c.finals_after_result.filter((f) => f.cue));
  if (late.length) reasons.push(`note: ${late.length} correction-cue transcript(s) finalised after tool.result was sent (handled by re-validation on the next call, not by the buffer)`);

  const silence = mut.map((c) => c.silence_total_ms).filter((x): x is number => x !== null);
  const p95 = pct(silence, 0.95);
  if (p95 !== null && p95 > 1500) reasons.push(`H5 WARN: p95 silence (speech end → first agent audio) is ${Math.round(p95)}ms > 1500ms: demo may feel laggy`);

  const interrupts = barge.filter((b) => b.kind === 'interrupt');
  if (!interrupts.length) reasons.push('note: no interrupted turn captured yet: the D-02 derivation fixture is still missing');

  const verdict: SpikeVerdict = fail ? 'FAIL' : blind.length ? 'PASS_WITH_BUFFER' : 'PASS';
  return {
    verdict, suggested_buffer_ms: suggested, reasons,
    stats: {
      mutating_calls: mut.length, corrections: corrections.length, blind_corrections: blind.length,
      vad_lag_ms_p50: pct(lags, 0.5), vad_lag_ms_p95: pct(lags, 0.95),
      silence_ms_p50: pct(silence, 0.5), silence_ms_p95: p95,
      hold_ms_p50: pct(mut.map((c) => c.hold_ms).filter((x): x is number => x !== null), 0.5),
      barge_interrupts: interrupts.length, barge_backchannels: barge.filter((b) => b.kind === 'backchannel').length,
      interrupt_reaction_ms_p50: pct(interrupts.map((b) => b.reaction_ms).filter((x): x is number => x !== null), 0.5),
      tool_call_after_final_fraction: mut.length ? mut.filter((c) => c.final_before_call).length / mut.length : null,
    },
  };
}
