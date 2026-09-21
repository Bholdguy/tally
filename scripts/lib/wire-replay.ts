// Turn a captured Voice Agent JSONL (inbound wire messages) into the TallyEvents the live AgentSession would have emitted,
// using the SAME WireEventStream (rule 7: replay and live share the code path). Used by tests and the replay tools.
import { readFileSync } from 'node:fs';
import type { TallyEvent } from '@tally/contract';
import { WireEventStream } from '../../agent/src/wire-events.js';

export function agentEventsFromCapture(file: string, session = 's'): TallyEvent[] {
  const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const wire = new WireEventStream({ mode: 'replay', config_version: 'capture' });
  const out: TallyEvent[] = [];
  let n = 0;
  for (const l of lines) {
    if (l.dir !== 'in') continue;
    for (const d of wire.process(l.msg).drafts) {
      out.push({ ...d, id: `${session}-e${++n}`, session_id: session, t_ms: l.t_ms, wall_ms: l.wall_ms ?? 0, audio_offset_ms: l.audio_offset_ms ?? 0 } as TallyEvent);
    }
  }
  return out;
}
