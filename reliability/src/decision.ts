/**
 * An AllowDecision is the only thing the committer accepts (rule 8). It can be minted only by the gate;
 * `npm run check:boundaries` fails if `mintAllow` is referenced outside reliability/src/gate* or this file.
 */
declare const allowBrand: unique symbol;

export interface AllowDecision {
  readonly [allowBrand]: true;
  readonly validation_event_id: string;
  readonly session_id: string;
  readonly aai_call_id: string;
}

export function mintAllow(validation_event_id: string, session_id: string, aai_call_id: string): AllowDecision {
  return Object.freeze({ validation_event_id, session_id, aai_call_id }) as unknown as AllowDecision;
}
