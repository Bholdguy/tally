import type { TallyEvent } from '@tally/contract';

// Wire → normalised-event mapping for the AssemblyAI Voice Agent API. Tolerant by design (DECISIONS D-13):
// docs disagree across pages, so we require only the fields we depend on and keep everything else in `raw`.

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;
export type EventDraft = DistributiveOmit<TallyEvent, 'id' | 'session_id' | 't_ms' | 'wall_ms' | 'audio_offset_ms' | 'raw'>;

export interface ToolCallWire { call_id: string; name: string; arguments: unknown }

export type Normalised =
  | { type: 'event'; draft: EventDraft }
  | { type: 'ready'; session_id: string | null }
  | { type: 'ignored'; wire_type: string } // reply.audio, transcript.agent.delta, session.updated, ...
  | { type: 'warning'; draft: EventDraft };

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const warn = (message: string): Normalised => ({ type: 'warning', draft: { kind: 'parse_warning', message } });

export function normaliseWire(msg: unknown): Normalised {
  if (typeof msg !== 'object' || msg === null || typeof (msg as any).type !== 'string') return warn('message without string "type"');
  const m = msg as Record<string, unknown>;
  const t = m.type as string;
  switch (t) {
    case 'session.ready':
      return { type: 'ready', session_id: str(m.session_id) ?? null };
    case 'input.speech.started':
      return { type: 'event', draft: { kind: 'input_speech_started' } };
    case 'input.speech.stopped':
      return { type: 'event', draft: { kind: 'input_speech_stopped' } };
    case 'transcript.user.delta':
    case 'transcript.user': {
      const text = str(m.text);
      if (text === undefined) return warn(`${t} without text`);
      return { type: 'event', draft: { kind: t === 'transcript.user' ? 'transcript_user' : 'transcript_user_delta', text, item_id: str(m.item_id) } };
    }
    case 'reply.started':
      return { type: 'event', draft: { kind: 'reply_started', reply_id: str(m.reply_id) } };
    case 'transcript.agent': {
      const text = str(m.text);
      if (text === undefined) return warn('transcript.agent without text');
      return { type: 'event', draft: { kind: 'transcript_agent', text, reply_id: str(m.reply_id), item_id: str(m.item_id), interrupted: typeof m.interrupted === 'boolean' ? m.interrupted : undefined } };
    }
    case 'reply.done': {
      const status = m.status;
      if (status !== 'completed' && status !== 'interrupted') return warn(`reply.done with unexpected status ${JSON.stringify(status)}`);
      return { type: 'event', draft: { kind: 'reply_done', status, reply_id: str(m.reply_id) } };
    }
    case 'tool.call': {
      const call_id = str(m.call_id);
      const name = str(m.name);
      if (!call_id || !name) return warn('tool.call without call_id/name');
      let args: unknown = m.arguments;
      if (typeof args === 'string') { // docs say object; tolerate a JSON string
        try { args = JSON.parse(args); } catch { return warn('tool.call arguments is a non-JSON string'); }
      }
      return { type: 'event', draft: { kind: 'tool_call', aai_call_id: call_id, tool: name, args } };
    }
    case 'session.error':
    case 'error':
      return { type: 'event', draft: { kind: 'session_error', code: str(m.code) ?? 'unknown', message: str(m.message) ?? '' } };
    case 'session.ended':
      return { type: 'event', draft: { kind: 'session_ended' } };
    case 'reply.audio':
    case 'transcript.agent.delta':
    case 'session.updated':
      return { type: 'ignored', wire_type: t };
    default:
      return { type: 'ignored', wire_type: t };
  }
}
