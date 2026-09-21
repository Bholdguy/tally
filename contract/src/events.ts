import { z } from 'zod';
import { ConflictCode } from './conflict.js';

/**
 * Normalised evidence events. Plane 1 maps wire messages to these; Plane 2 only ever sees these.
 * t_ms/wall_ms/audio_offset_ms are stamped on receipt (DECISIONS D-05). Voice Agent events also carry the SERVER's own
 * timestamp (`server_ts_ms`, epoch ms, from the wire `timestamp` field, verified in the spike); it is preferred for ordering.
 */
const Base = z.object({
  id: z.string(),
  session_id: z.string(),
  t_ms: z.number().nonnegative(),
  wall_ms: z.number().int().nonnegative(),
  audio_offset_ms: z.number().nonnegative(),
  server_ts_ms: z.number().optional(),
  raw: z.unknown().optional(),
});

export const TallyEvent = z.discriminatedUnion('kind', [
  Base.extend({ kind: z.literal('session_started'), mode: z.enum(['live', 'demo', 'replay']), config_version: z.string() }),
  Base.extend({ kind: z.literal('input_speech_started') }),
  Base.extend({ kind: z.literal('input_speech_stopped') }),
  Base.extend({ kind: z.literal('transcript_user_delta'), text: z.string(), item_id: z.string().optional() }),
  Base.extend({ kind: z.literal('transcript_user'), text: z.string(), item_id: z.string().optional() }),
  Base.extend({ kind: z.literal('reply_started'), reply_id: z.string().optional() }),
  // first NON-SILENT audio chunk of a reply (D-18: reply_started alone is silence padding in hold mode)
  Base.extend({ kind: z.literal('reply_audible'), reply_id: z.string().optional() }),
  Base.extend({ kind: z.literal('transcript_agent'), text: z.string(), reply_id: z.string().optional(), item_id: z.string().optional(), interrupted: z.boolean().optional() }),
  Base.extend({ kind: z.literal('reply_done'), status: z.enum(['completed', 'interrupted']), reply_id: z.string().optional() }),
  Base.extend({ kind: z.literal('tool_call'), aai_call_id: z.string(), tool: z.string(), args: z.unknown() }),
  Base.extend({ kind: z.literal('barge_in'), derived: z.literal(true), source_event_ids: z.array(z.string()).length(2), reaction_ms: z.number().optional() }),
  // Independent evidence (D-04): Tally's own STT stream + local voice-activity check on the same input PCM.
  Base.extend({
    kind: z.literal('evidence_transcript'),
    text: z.string(),
    end_of_turn: z.boolean(),
    turn_order: z.number().int().nonnegative(),
    words: z.array(z.object({ text: z.string(), confidence: z.number().min(0).max(1) })).default([]),
  }),
  Base.extend({ kind: z.literal('evidence_speech_started') }),
  Base.extend({ kind: z.literal('evidence_stream_status'), status: z.enum(['up', 'down']), reason: z.string().optional() }),
  Base.extend({ kind: z.literal('local_vad'), state: z.enum(['speech_start', 'speech_end']) }),
  // Tally's own output (never from a wire): a repair was asked / escalated / resolved. For the timeline and call log (Step 11).
  Base.extend({ kind: z.literal('repair'), outcome: z.enum(['asked', 'escalated', 'resolved']), aai_call_id: z.string().optional(), code: ConflictCode.optional(), scope: z.string(), attempt: z.number().int().optional(), ask_text: z.string().optional() }),
  // a hold became a stored, replayable case (Step 7); `threshold_reached` flips the regression counters
  Base.extend({ kind: z.literal('case'), case_id: z.string(), tool_call_id: z.string(), conflict_type: z.string(), pattern_key: z.string(), tag: z.string(), pattern_count: z.number().int(), resolution: z.string(), threshold_reached: z.boolean() }),
  // Tally's own outputs for the dashboard (never from a wire; excluded from replay snapshots, which regenerate them):
  // the gate is WAITING on independent evidence (drives the beat-5b countdown) ...
  Base.extend({ kind: z.literal('gate_waiting'), aai_call_id: z.string(), tool: z.string(), max_ms: z.number(), reason: z.string() }),
  // ... the verdict on a gated tool call ...
  Base.extend({
    kind: z.literal('verdict'), aai_call_id: z.string(), tool: z.string(), args: z.unknown(), verdict: z.enum(['ALLOW', 'HOLD']),
    code: ConflictCode.optional(), noop: z.boolean().optional(), repaired: z.boolean().optional(), waited_ms: z.number().optional(), detail: z.string().optional(),
  }),
  // ... and the committed order after a change (the order panel renders this and nothing else)
  Base.extend({ kind: z.literal('order'), lines: z.array(z.object({ item_id: z.string(), quantity: z.number(), modifiers: z.array(z.string()) })), total_cents: z.number(), status: z.string() }),
  Base.extend({ kind: z.literal('parse_warning'), message: z.string() }),
  Base.extend({ kind: z.literal('session_error'), code: z.string(), message: z.string() }),
  Base.extend({ kind: z.literal('session_ended') }),
]);
export type TallyEvent = z.infer<typeof TallyEvent>;
export type TallyEventKind = TallyEvent['kind'];

/** Request into the gate from Plane 1's tool handler. */
export const ToolCallRequest = z.object({
  session_id: z.string(),
  aai_call_id: z.string(),
  tool: z.string(),
  args: z.unknown(),
  received_t_ms: z.number(),
});
export type ToolCallRequest = z.infer<typeof ToolCallRequest>;

/** Plain data: what Plane 1 should ask. Tally supplies instructions only (DECISIONS D-09). */
export const RepairInstruction = z.object({
  aai_call_id: z.string(),
  code: ConflictCode,
  item_id: z.string().optional(),
  evidenced_value: z.string().optional(),
  ask_text: z.string(),
  attempt: z.number().int().min(1),
  /** true once MAX_REPAIR_ATTEMPTS were spent on this scope: `ask_text` is then the hand-off wording, not a question */
  escalated: z.boolean().optional(),
});
export type RepairInstruction = z.infer<typeof RepairInstruction>;

export const GateResult = z.discriminatedUnion('verdict', [
  z.object({ verdict: z.literal('ALLOW'), validation_event_id: z.string(), actual_result: z.unknown(), noop: z.boolean().optional(), waited_ms: z.number().optional(), repaired: z.boolean().optional() }),
  z.object({
    verdict: z.literal('HOLD'),
    code: ConflictCode,
    validation_event_id: z.string(),
    repair: RepairInstruction.optional(),
    detail: z.string().optional(),
    /** set when the call was an agent misuse of the tools (not a disagreement with the customer): no repair question is asked */
    projection_error: z.string().optional(),
    waited_ms: z.number().optional(),
  }),
]);
export type GateResult = z.infer<typeof GateResult>;
