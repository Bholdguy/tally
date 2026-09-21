// Derived barge-in (DECISIONS D-02, D-18). AssemblyAI has no barge-in event. A barge-in is DERIVED as:
//   input_speech_started while a reply is in flight AND AUDIBLE (not hold-mode silence padding), followed by
//   reply_done{status:"interrupted"}.
// A reply that completes normally after speech began is a backchannel (0/2 interrupted in the spike): no marker.
// Spike-verified wire order for a genuine interruption: transcript_agent{interrupted} -> input_speech_started ->
// reply_done{interrupted}, all within ~1 ms, so this state machine never depends on the transcript_agent position.
import type { TallyEvent } from '@tally/contract';

type BargeIn = Extract<TallyEvent, { kind: 'barge_in' }>;

export class BargeInDeriver {
  private inReply = false;
  private audible = false;
  private pending: { id: string; t_ms: number; server_ts_ms?: number } | null = null;

  /** Feed agent-stream events in arrival order. Returns a derived barge_in event when one is detected. */
  ingest(e: TallyEvent): BargeIn | null {
    switch (e.kind) {
      case 'reply_started':
        this.inReply = true; this.audible = false; this.pending = null;
        return null;
      case 'reply_audible':
        if (this.inReply) this.audible = true;
        return null;
      case 'input_speech_started':
        // only speech over AUDIBLE agent speech can interrupt it; speech over silence padding is just a user turn
        if (this.inReply && this.audible && !this.pending) this.pending = { id: e.id, t_ms: e.t_ms, server_ts_ms: e.server_ts_ms };
        return null;
      case 'reply_done': {
        const p = this.pending;
        const interrupted = e.status === 'interrupted';
        this.inReply = false; this.audible = false; this.pending = null;
        if (!interrupted || !p) return null; // completed normally = backchannel (or nothing to attribute the interruption to)
        // prefer the server's own clock for the reaction time when both events carry it (D-05)
        const reaction = p.server_ts_ms !== undefined && e.server_ts_ms !== undefined ? e.server_ts_ms - p.server_ts_ms : e.t_ms - p.t_ms;
        return {
          id: `${e.id}:barge_in`, session_id: e.session_id, kind: 'barge_in', derived: true,
          t_ms: e.t_ms, wall_ms: e.wall_ms, audio_offset_ms: e.audio_offset_ms, server_ts_ms: e.server_ts_ms,
          source_event_ids: [p.id, e.id], reaction_ms: Math.max(0, reaction),
        };
      }
      default:
        return null;
    }
  }
}
