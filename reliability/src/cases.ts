// Step 7: pattern keys. Pure and deterministic (no LLM, no clock): the same failure always maps to the same key, so "three
// repeats of the same failure" is countable. PRD §B.10: pattern_key = conflict_type | tool_name | cue_class | position_in_item.
import { MENU, type ConflictCode } from '@tally/contract';

export type CueClass = 'correction' | 'modifier_phrase' | 'plain_statement' | 'stream_down' | 'low_confidence' | 'evidence_timeout' | 'no_evidence';
export type Position = 'mid_item' | 'after_item' | 'before_item' | 'na';

export interface PatternInput {
  code: ConflictCode;
  tool: string;
  item_id?: string;
  /** the customer's finalised utterances from the INDEPENDENT stream, in order (what the gate judged against) */
  utterances: readonly string[];
  /** the gate's own explanation; used only to tell apart WHY evidence was unavailable */
  detail?: string;
}

const CORRECTION = /\b(no,? wait|wait,? no|actually|i mean|make (it|that)|scratch that|change (it|that)|never ?mind|on second thought|instead of that)\b/i;
const MODIFIER = /\b(no|without|extra|add|with|hold the|instead of|large|small|spicy|gluten)\b/i;

const mentions = (text: string, item_id: string): boolean => {
  const it = MENU.find((m) => m.item_id === item_id);
  if (!it) return false;
  return [it.name.toLowerCase(), ...it.aliases].some((a) => new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?\\b`, 'i').test(text));
};

export function derivePattern(i: PatternInput): { cue_class: CueClass; position: Position; key: string } {
  let cue_class: CueClass;
  let position: Position = 'na';
  const d = (i.detail ?? '').toLowerCase();
  if (i.code === 'PENDING_EVIDENCE') cue_class = 'evidence_timeout';
  else if (i.code === 'UNVALIDATABLE') {
    cue_class = /stream|stalled|silent while speech/.test(d) ? 'stream_down' : /confidence|homophone|ambiguous/.test(d) ? 'low_confidence' : 'no_evidence';
  } else if (i.utterances.some((u) => CORRECTION.test(u))) {
    cue_class = 'correction';
    const cueIdx = i.utterances.findIndex((u) => CORRECTION.test(u));
    const itemIdx = i.item_id ? i.utterances.findIndex((u) => mentions(u, i.item_id!)) : -1;
    position = itemIdx < 0 ? 'na' : cueIdx === itemIdx ? 'mid_item' : cueIdx > itemIdx ? 'after_item' : 'before_item';
  } else if (i.utterances.some((u) => MODIFIER.test(u)) && ['MODIFIER_MISMATCH', 'REMOVAL_MISMATCH', 'SUBSTITUTION_MISMATCH', 'BAD_MODIFIER'].includes(i.code)) cue_class = 'modifier_phrase';
  else cue_class = 'plain_statement';
  return { cue_class, position, key: `${i.code}|${i.tool}|${cue_class}|${position}` };
}
