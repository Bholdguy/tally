import type { TallyEvent } from '@tally/contract';
import { pcmRms } from './session.js';
import { normaliseWire, type EventDraft } from './wire.js';

/**
 * Stateful wire -> event-draft translation, shared by the live AgentSession and by replays of captured JSONL so both
 * derive identical events (rule 7). It adds what a stateless mapping cannot:
 *  - `server_ts_ms` from the wire `timestamp` (epoch seconds, present on every inbound event, spike finding F9);
 *  - `reply_audible`: emitted once per reply on the first NON-SILENT audio chunk (RMS > 100), because in hold mode the
 *    server streams silence frames under `reply.started` (D-18) and a reply is not "speaking" until audible.
 */
export const AUDIBLE_RMS = 100;

export interface WireOut {
  /** drafts to stamp and emit, in order */
  drafts: EventDraft[];
  /** session.ready seen */
  ready?: { session_id: string | null };
  /** decoded reply audio (for playback), if this message was reply.audio */
  audio?: Uint8Array;
}

export class WireEventStream {
  private audible = false;
  private replyId: string | undefined;

  constructor(private readonly ctx: { mode: 'live' | 'demo' | 'replay'; config_version: string }) {}

  process(msg: any): WireOut {
    const server_ts_ms = typeof msg?.timestamp === 'number' && Number.isFinite(msg.timestamp) ? Math.round(msg.timestamp * 1000) : undefined;
    const withTs = (d: EventDraft): EventDraft => (server_ts_ms === undefined ? d : ({ ...d, server_ts_ms } as EventDraft));
    const n = normaliseWire(msg);

    if (n.type === 'ready') {
      return { ready: { session_id: n.session_id }, drafts: [withTs({ kind: 'session_started', mode: this.ctx.mode, config_version: this.ctx.config_version })] };
    }
    if (n.type === 'event' || n.type === 'warning') {
      if (n.draft.kind === 'reply_started') { this.audible = false; this.replyId = n.draft.reply_id; }
      return { drafts: [withTs(n.draft)] };
    }
    if (msg?.type === 'reply.audio') {
      let rms: number | undefined = typeof msg.rms === 'number' ? msg.rms : undefined; // captured logs carry RMS instead of the payload
      let audio: Uint8Array | undefined;
      if (typeof msg.data === 'string' && !msg.data.startsWith('<')) {
        audio = Buffer.from(msg.data, 'base64');
        rms = rms ?? pcmRms(audio);
      }
      const drafts: EventDraft[] = [];
      if (!this.audible && (rms ?? 0) > AUDIBLE_RMS) {
        this.audible = true;
        drafts.push(withTs({ kind: 'reply_audible', reply_id: this.replyId } as EventDraft));
      }
      return { drafts, audio };
    }
    return { drafts: [] };
  }
}

export type { TallyEvent };
