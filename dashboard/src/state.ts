// The live view's state: a PURE reducer over the typed events the server streams (SSE) or stores. No I/O, no clock, no DOM: the same
// events always produce the same state, so the timeline, call log and order panel can be tested without a browser.
import { NON_DEFINITE_CODES, itemName, modifierLabel } from '@tally/contract';

export interface Ev { id: string; session_id: string; kind: string; t_ms: number; wall_ms: number; [k: string]: any }
export interface Seg { start: number; end: number | null; interrupted?: boolean }
/** allowed = green, repaired = yellow, conflict/held = red, waiting/pending = grey. Colour is never the only signal: every status has a label. */
export type CallStatus = 'pending' | 'waiting' | 'allowed' | 'repaired' | 'noop' | 'conflict' | 'held';
export interface CallRec { id: string; tool: string; args: unknown; start: number; end: number | null; status: CallStatus; code?: string; waited_ms?: number; detail?: string }
export interface Line { key: string; t: number; text: string; final: boolean; low?: boolean }
export interface LogLine { t: number; kind: 'call' | 'verdict' | 'repair' | 'case' | 'drift' | 'barge' | 'system'; text: string; status?: CallStatus }
export interface Waiting { call_id: string; tool: string; since_wall: number; max_ms: number; reason: string }
export interface OrderView { lines: { item_id: string; quantity: number; modifiers: string[] }[]; total_cents: number; status: string }

export interface LiveState {
  session_id: string | null; mode: string | null; t_max: number; ended: boolean;
  customer: Seg[]; independent: number[]; agent: Seg[];
  bargeIns: { t: number; ids: string[]; reaction_ms?: number }[];
  calls: CallRec[]; waiting: Waiting | null;
  stream: { status: 'unknown' | 'up' | 'down'; reason?: string };
  transcripts: { independent: Line[]; voiceAgent: Line[]; agent: Line[] };
  log: LogLine[]; order: OrderView | null; cases: number;
}

export const initialLive = (): LiveState => ({
  session_id: null, mode: null, t_max: 0, ended: false, customer: [], independent: [], agent: [], bargeIns: [], calls: [], waiting: null,
  stream: { status: 'unknown' }, transcripts: { independent: [], voiceAgent: [], agent: [] }, log: [], order: null, cases: 0,
});

export function statusOf(verdict: 'ALLOW' | 'HOLD', o: { code?: string; noop?: boolean; repaired?: boolean }): CallStatus {
  if (verdict === 'ALLOW') return o.noop ? 'noop' : o.repaired ? 'repaired' : 'allowed';
  return o.code && (NON_DEFINITE_CODES as readonly string[]).includes(o.code) ? 'held' : 'conflict';
}
/** the words next to the colour */
export function statusLabel(c: Pick<CallRec, 'status' | 'code'>): string {
  switch (c.status) {
    case 'allowed': return 'ALLOWED';
    case 'repaired': return 'ALLOWED · REPAIRED';
    case 'noop': return 'ALLOWED · NO CHANGE';
    case 'conflict': return `CONFLICT ${c.code ?? ''}`.trim();
    case 'held': return `HELD ${c.code ?? ''}`.trim();
    case 'waiting': return 'WAITING ON INDEPENDENT EVIDENCE';
    default: return 'PENDING';
  }
}

const upsert = (lines: Line[], l: Line): Line[] => {
  const i = lines.findIndex((x) => x.key === l.key);
  if (i < 0) return [...lines, l];
  const out = lines.slice(); out[i] = { ...out[i]!, ...l }; return out;
};
const closeLast = (segs: Seg[], t: number, extra: Partial<Seg> = {}): Seg[] => {
  const i = segs.length - 1;
  if (i < 0 || segs[i]!.end !== null) return segs;
  const out = segs.slice(); out[i] = { ...out[i]!, end: t, ...extra }; return out;
};
const TOOLS = new Set(['add_item', 'remove_item', 'update_quantity', 'apply_modifier', 'confirm_order', 'get_order_state', 'agent_speech']);
/** an agent-supplied tool name is shown only if it is one of ours; anything else is "unknown tool" (never an attacker-chosen string) */
export const toolName = (t: unknown): string => (typeof t === 'string' && TOOLS.has(t) ? t : 'unknown tool');

const CUE_WORDS: Record<string, string> = { correction: 'customer correction', modifier_phrase: 'option request', plain_statement: 'plain statement', stream_down: 'evidence stream down', low_confidence: 'low transcription confidence', evidence_timeout: 'evidence wait timed out', no_evidence: 'no evidence' };
const POS_WORDS: Record<string, string> = { mid_item: 'in the same breath as the item', after_item: 'after the item was named', before_item: 'before the item was named' };
/** "QTY_MISMATCH|add_item|correction|after_item" -> "QTY_MISMATCH · add_item · customer correction, after the item was named" (the raw key stays in a tooltip) */
export function describePattern(key: unknown): string {
  const [code, tool, cue, pos] = String(key ?? '').split('|');
  const words = [CUE_WORDS[cue ?? ''] ?? '', POS_WORDS[pos ?? ''] ?? ''].filter(Boolean).join(', ');
  return `${/^[A-Z_]+$/.test(code ?? '') ? code : 'case'} · ${toolName(tool)}${words ? ` · ${words}` : ''}`;
}

/** the call in words: the tool name (the operator's vocabulary) and the item as a NAME, never a raw id or arbitrary agent-supplied text */
const callText = (tool: string, args: any): string => {
  const a = args && typeof args === 'object' ? args : {};
  const item = typeof a.item_id === 'string' ? ` ${itemName(a.item_id)}` : '';
  const qty = typeof a.quantity === 'number' ? ` ×${a.quantity}` : '';
  const mod = typeof a.modifier === 'string' ? ` +${modifierLabel(a.modifier)}` : '';
  const pick = typeof a.pickup_time === 'string' ? ` @${a.pickup_time === 'ASAP' ? 'ASAP' : 'a set time'}` : '';
  return `${toolName(tool)}${item}${qty}${mod}${pick}`;
};

export function reduce(s: LiveState, e: Ev): LiveState {
  const t = e.t_ms;
  const n: LiveState = { ...s, t_max: Math.max(s.t_max, t), session_id: s.session_id ?? e.session_id };
  const withCall = (id: string, f: (c: CallRec) => CallRec): CallRec[] => {
    const i = n.calls.findIndex((c) => c.id === id);
    if (i < 0) return [...n.calls, f({ id, tool: '?', args: null, start: t, end: null, status: 'pending' })];
    const out = n.calls.slice(); out[i] = f(out[i]!); return out;
  };
  switch (e.kind) {
    case 'session_started': return { ...n, mode: e.mode };
    case 'session_ended': return { ...n, ended: true, waiting: null, customer: closeLast(n.customer, t), agent: closeLast(n.agent, t) };
    case 'local_vad': return e.state === 'speech_start' ? { ...n, customer: [...n.customer, { start: t, end: null }] } : { ...n, customer: closeLast(n.customer, t) };
    case 'evidence_speech_started': return { ...n, independent: [...n.independent, t] };
    case 'evidence_stream_status': return { ...n, stream: { status: e.status, reason: e.reason }, log: e.status === 'down' ? [...n.log, { t, kind: 'system', text: `independent evidence stream DOWN${e.reason ? ` (${e.reason})` : ''}` }] : n.log };
    case 'evidence_transcript': {
      const words: { confidence: number }[] = Array.isArray(e.words) ? e.words : [];
      const low = words.length > 0 && Math.min(...words.map((w) => w.confidence)) < 0.6;
      return { ...n, transcripts: { ...n.transcripts, independent: upsert(n.transcripts.independent, { key: `turn${e.turn_order}`, t, text: e.text, final: !!e.end_of_turn, low }) } };
    }
    case 'transcript_user_delta': return { ...n, transcripts: { ...n.transcripts, voiceAgent: upsert(n.transcripts.voiceAgent, { key: e.item_id ?? `d${n.transcripts.voiceAgent.length}`, t, text: e.text, final: false }) } };
    case 'transcript_user': return { ...n, transcripts: { ...n.transcripts, voiceAgent: upsert(n.transcripts.voiceAgent, { key: e.item_id ?? `u${n.transcripts.voiceAgent.length}`, t, text: e.text, final: true }) } };
    case 'transcript_agent': return { ...n, transcripts: { ...n.transcripts, agent: [...n.transcripts.agent, { key: e.id, t, text: e.text, final: !e.interrupted }] } };
    case 'reply_audible': return { ...n, agent: [...n.agent, { start: t, end: null }] };
    case 'reply_done': return { ...n, agent: closeLast(n.agent, t, { interrupted: e.status === 'interrupted' }) };
    case 'barge_in': return { ...n, bargeIns: [...n.bargeIns, { t, ids: e.source_event_ids ?? [], reaction_ms: e.reaction_ms }], log: [...n.log, { t, kind: 'barge', text: 'BARGE-IN derived: customer speech began over an audible agent reply that was then interrupted' }] };
    case 'tool_call': return { ...n, calls: withCall(e.aai_call_id, (c) => ({ ...c, tool: e.tool, args: e.args, start: t })), log: [...n.log, { t, kind: 'call', text: `CALL ${callText(e.tool, e.args)}` }] };
    case 'gate_waiting':
      return { ...n, waiting: { call_id: e.aai_call_id, tool: e.tool, since_wall: e.wall_ms, max_ms: e.max_ms, reason: e.reason }, calls: withCall(e.aai_call_id, (c) => ({ ...c, status: 'waiting', tool: c.tool === '?' ? e.tool : c.tool })), log: [...n.log, { t, kind: 'verdict', status: 'waiting', text: `WAITING on independent evidence: ${e.reason}` }] };
    case 'verdict': {
      const status = statusOf(e.verdict, { code: e.code, noop: e.noop, repaired: e.repaired });
      return {
        ...n, waiting: n.waiting?.call_id === e.aai_call_id ? null : n.waiting,
        calls: withCall(e.aai_call_id, (c) => ({ ...c, tool: e.tool, args: e.args ?? c.args, end: t, status, code: e.code, waited_ms: e.waited_ms, detail: e.detail })),
        log: [...n.log, { t, kind: 'verdict', status, text: `${statusLabel({ status, code: e.code })} ${callText(e.tool, e.args)}${typeof e.waited_ms === 'number' && e.waited_ms > 100 ? ` · held ${(e.waited_ms / 1000).toFixed(1)} s waiting for evidence` : ''}` }],
      };
    }
    case 'repair': return { ...n, log: [...n.log, { t, kind: e.code === 'SPOKEN_STATE_DRIFT' || e.code === 'TOTAL_MISMATCH' ? 'drift' : 'repair', text: e.outcome === 'resolved' ? `REPAIR resolved (${e.scope})` : `REPAIR${e.outcome === 'escalated' ? ' ESCALATED' : ''}: "${e.ask_text ?? ''}"` }] };
    case 'case': return { ...n, cases: n.cases + 1, log: [...n.log, { t, kind: 'case', text: `CASE logged: ${describePattern(e.pattern_key)}${e.threshold_reached ? ' · repeat threshold reached' : ''}` }] };
    case 'order': return { ...n, order: { lines: e.lines, total_cents: e.total_cents, status: e.status } };
    default: return n;
  }
}

export const reduceAll = (events: readonly Ev[], from: LiveState = initialLive()): LiveState => events.reduce(reduce, from);
