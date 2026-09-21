// Spike A analysis: did Tally's independent STT stream deliver the customer's correction, when, and while the primary
// Voice Agent session was in a hold? Pure functions over captured JSONL; unit-tested on synthetic data.
import type { SttRaw } from '../../../stt/src/stream.js';
import type { RawLine } from './analyze.js';

const CORRECTION_TEXT = /\b(3|three)\b/i;
const CUE = /\b(wait|make it|actually)\b/i;

export interface SttTurnLite { t: number; eot: boolean; text: string; minConf: number | null }
export interface CorrectionEvidence {
  label: string;
  t_start_ms: number;                  // when we began sending the correction audio (session clock)
  t_end_ms: number | null;             // when we finished sending it
  t_call_ms: number | null;            // first primary tool.call after the correction began (or the first add_item)
  t_result_ms: number | null;          // when our tool.result for that call was sent (end of the hold Tally controls)
  call_qty: unknown;
  primary_delivered: boolean;          // did the Voice Agent live stream deliver a transcript.user with the correction?
  stt_delivered: boolean;              // did the independent stream deliver ANY turn containing it (partial or final)?
  stt_first_ms: number | null;         // first (partial) turn containing 3/three after the correction began
  stt_final_ms: number | null;         // first end_of_turn turn containing it
  stt_text: string | null;             // that final turn's text
  stt_min_word_conf: number | null;
  stt_has_cue: boolean;                // final text also carries the correction cue ("wait"/"make it")
  first_after_call_ms: number | null;  // stt_first - t_call (negative = evidence was already in hand at tool.call)
  final_after_call_ms: number | null;  // stt_final - t_call
  final_lag_after_speech_end_ms: number | null;
  first_before_call: boolean | null;   // partial evidence available by tool.call
  final_before_call: boolean | null;
  stt_turns_during_hold: number;       // independent-stream messages received between tool.call and our tool.result
}
export interface SttRunFacts {
  scenario: string;
  stt_turn_count: number;
  first_utterance_final_ms: number | null;   // independent stream's first end_of_turn (normal, uncorrected path)
  first_call_ms: number | null;
  first_utterance_final_before_call: boolean | null;
  first_utterance_text: string | null;
  corrections: CorrectionEvidence[];
}

const turns = (stt: SttRaw[]): SttTurnLite[] => stt.filter((r) => r.dir === 'in' && (r.msg as any)?.type === 'Turn').map((r) => {
  const m: any = r.msg;
  const confs = Array.isArray(m.words) ? m.words.map((w: any) => w.confidence).filter((c: unknown): c is number => typeof c === 'number') : [];
  return { t: r.t_ms, eot: !!m.end_of_turn, text: String(m.transcript ?? ''), minConf: confs.length ? Math.min(...confs) : null };
});

export function analyseSttRun(scenario: string, primary: RawLine[], stt: SttRaw[]): SttRunFacts {
  const tt = turns(stt);
  type Rec = Exclude<RawLine, { dir: 'marker' }>;
  type Mk = Extract<RawLine, { dir: 'marker' }>;
  const ins = primary.filter((l): l is Rec => l.dir === 'in');
  const outs = primary.filter((l): l is Rec => l.dir === 'out');
  const markers = primary.filter((l): l is Mk => l.dir === 'marker');
  const calls = ins.filter((l) => (l.msg as any)?.type === 'tool.call');
  const firstCall = calls.find((c) => (c.msg as any).name === 'add_item') ?? calls[0];
  const firstFinal = tt.find((x) => x.eot);

  const corrections: CorrectionEvidence[] = markers.filter((m) => m.label.startsWith('correction:')).map((mk) => {
    const clipName = markers.find((m) => m.t_ms >= mk.t_ms && m.label.startsWith('say:'))?.label.slice(4);
    const end = clipName ? markers.find((m) => m.t_ms >= mk.t_ms && m.label === `end:${clipName}`) : undefined;
    const call = calls.filter((c) => c.t_ms >= mk.t_ms - 3000).find((c) => (c.msg as any).name === 'add_item') ?? firstCall;
    const res = call ? outs.find((o) => (o.msg as any)?.type === 'tool.result' && (o.msg as any).call_id === (call.msg as any).call_id) : undefined;
    const after = tt.filter((x) => x.t >= mk.t_ms);
    const first = after.find((x) => CORRECTION_TEXT.test(x.text));
    const fin = after.find((x) => x.eot && CORRECTION_TEXT.test(x.text));
    const primaryDelivered = ins.some((l) => (l.msg as any)?.type === 'transcript.user' && l.t_ms >= mk.t_ms && (CORRECTION_TEXT.test((l.msg as any).text ?? '') && CUE.test((l.msg as any).text ?? '')));
    const tc = call?.t_ms ?? null;
    return {
      label: mk.label, t_start_ms: mk.t_ms, t_end_ms: end?.t_ms ?? null, t_call_ms: tc, t_result_ms: res?.t_ms ?? null,
      call_qty: call ? (call.msg as any).arguments?.quantity : null,
      primary_delivered: primaryDelivered,
      stt_delivered: !!first, stt_first_ms: first?.t ?? null, stt_final_ms: fin?.t ?? null, stt_text: fin?.text ?? null,
      stt_min_word_conf: fin?.minConf ?? null, stt_has_cue: !!fin && CUE.test(fin.text),
      first_after_call_ms: first && tc !== null ? first.t - tc : null,
      final_after_call_ms: fin && tc !== null ? fin.t - tc : null,
      final_lag_after_speech_end_ms: fin && end ? fin.t - end.t_ms : null,
      first_before_call: first && tc !== null ? first.t <= tc : null,
      final_before_call: fin && tc !== null ? fin.t <= tc : null,
      stt_turns_during_hold: tc !== null && res ? tt.filter((x) => x.t > tc && x.t <= res.t_ms).length : 0,
    };
  });

  return {
    scenario, stt_turn_count: tt.length,
    first_utterance_final_ms: firstFinal?.t ?? null, first_call_ms: firstCall?.t_ms ?? null,
    first_utterance_final_before_call: firstFinal && firstCall ? firstFinal.t <= firstCall.t_ms : null,
    first_utterance_text: firstFinal?.text ?? null,
    corrections,
  };
}

const pct = (xs: number[], p: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]!);
};

export interface ScenarioSummary {
  scenario: string; runs: number; corrections: number;
  primary_delivered: number; stt_delivered: number; stt_final_delivered: number; stt_correct_with_cue: number;
  first_before_call: number; final_before_call: number;
  wait_first_p50: number | null; wait_first_max: number | null; wait_final_p50: number | null; wait_final_max: number | null;
  final_lag_after_speech_end_p50: number | null; final_lag_after_speech_end_max: number | null;
  turns_during_hold_total: number; min_word_conf_min: number | null;
  first_utterance_final_before_call: string;
}

export function summarise(runs: SttRunFacts[]): ScenarioSummary[] {
  const by = new Map<string, SttRunFacts[]>();
  for (const r of runs) by.set(r.scenario, [...(by.get(r.scenario) ?? []), r]);
  return [...by.entries()].map(([scenario, rs]) => {
    const cs = rs.flatMap((r) => r.corrections);
    const nn = (xs: (number | null)[]) => xs.filter((x): x is number => x !== null);
    const waitFirst = nn(cs.map((c) => (c.first_after_call_ms === null ? null : Math.max(0, c.first_after_call_ms))));
    const waitFinal = nn(cs.map((c) => (c.final_after_call_ms === null ? null : Math.max(0, c.final_after_call_ms))));
    const lag = nn(cs.map((c) => c.final_lag_after_speech_end_ms));
    const fuBefore = rs.filter((r) => r.first_utterance_final_before_call !== null);
    return {
      scenario, runs: rs.length, corrections: cs.length,
      primary_delivered: cs.filter((c) => c.primary_delivered).length,
      stt_delivered: cs.filter((c) => c.stt_delivered).length,
      stt_final_delivered: cs.filter((c) => c.stt_final_ms !== null).length,
      stt_correct_with_cue: cs.filter((c) => c.stt_final_ms !== null && c.stt_has_cue).length,
      first_before_call: cs.filter((c) => c.first_before_call === true).length,
      final_before_call: cs.filter((c) => c.final_before_call === true).length,
      wait_first_p50: pct(waitFirst, 0.5), wait_first_max: waitFirst.length ? Math.round(Math.max(...waitFirst)) : null,
      wait_final_p50: pct(waitFinal, 0.5), wait_final_max: waitFinal.length ? Math.round(Math.max(...waitFinal)) : null,
      final_lag_after_speech_end_p50: pct(lag, 0.5), final_lag_after_speech_end_max: lag.length ? Math.round(Math.max(...lag)) : null,
      turns_during_hold_total: cs.reduce((n, c) => n + c.stt_turns_during_hold, 0),
      min_word_conf_min: (() => { const v = nn(cs.map((c) => c.stt_min_word_conf)); return v.length ? Math.min(...v) : null; })(),
      first_utterance_final_before_call: `${fuBefore.filter((r) => r.first_utterance_final_before_call).length}/${fuBefore.length}`,
    };
  });
}
