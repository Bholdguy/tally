import { z } from 'zod';

export const CONFLICT_CODES = [
  'QTY_MISMATCH', 'ITEM_MISMATCH', 'MODIFIER_MISMATCH', 'REMOVAL_MISMATCH', 'SUBSTITUTION_MISMATCH',
  'STALE_EVIDENCE', 'UNSUPPORTED_CLAIM', 'SPOKEN_STATE_DRIFT', 'TOOL_RESULT_LIE', 'TOTAL_MISMATCH',
  'SCHEMA_INVALID', 'UNKNOWN_ITEM', 'BAD_MODIFIER', 'PICKUP_TIME_MISMATCH', 'PENDING_EVIDENCE', 'UNVALIDATABLE',
] as const;
export const ConflictCode = z.enum(CONFLICT_CODES);
export type ConflictCode = z.infer<typeof ConflictCode>;

export const Verdict = z.enum(['ALLOW', 'HOLD']);
export type Verdict = z.infer<typeof Verdict>;

/** tool_calls.status in the data model */
export const ToolCallStatus = z.enum(['allowed', 'held', 'conflict']);
export type ToolCallStatus = z.infer<typeof ToolCallStatus>;

export const RepairOutcome = z.enum(['resolved', 'escalated', 'pending']);
export type RepairOutcome = z.infer<typeof RepairOutcome>;

export const CaseTag = z.enum(['none', 'regression_candidate', 'regression']);
export type CaseTag = z.infer<typeof CaseTag>;

export const EntityType = z.enum(['item', 'quantity', 'modifier', 'removal', 'substitution', 'total', 'pickup_time']);
export type EntityType = z.infer<typeof EntityType>;

/** Codes where the gate refuses to decide rather than finding a definite mismatch. */
export const NON_DEFINITE_CODES: readonly ConflictCode[] = ['PENDING_EVIDENCE', 'UNVALIDATABLE'];
