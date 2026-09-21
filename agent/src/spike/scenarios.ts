// Spike scenarios. Each is a script of audio steps streamed at real time. Corrections carry a marker so the analyzer can
// compare "when we started saying it" with "when the API told us" (all client-stamped, D-05).
export type Step =
  | { say: string; marker?: string }                                          // stream a clip; marker = 'correction:<name>'
  | { silence: number }                                                       // stream silence (keeps the input real-time)
  | { until: 'reply_started' | 'tool_call' | 'reply_done'; timeoutMs: number } // stream silence until the event arrives
  | { untilAgentSpeech: number }                                              // stream silence until NON-SILENT agent audio arrives (run 1 lesson: reply.started alone is silence padding)
  | { quiet: number; maxMs: number };                                         // stream silence until no events for `quiet` ms

export interface Scenario {
  name: string;
  description: string;
  stubDelayMs?: number; // artificial tool latency: lengthens the hold so mid-hold speech can be observed
  steps: Step[];
}

export const SCENARIOS: Scenario[] = [
  { name: 'clean_order', description: 'A: clean order, no interruptions', steps: [{ say: 'clean' }, { quiet: 3500, maxMs: 30000 }] },
  { name: 'inline_correction', description: 'B: correction inside one utterance', steps: [{ say: 'inline_corr', marker: 'correction:inline' }, { quiet: 3500, maxMs: 30000 }] },
  ...[400, 900, 1500].map((gap): Scenario => ({
    name: `late_correction_${gap}ms`,
    description: `correction after a ${gap}ms pause following the first utterance`,
    steps: [{ say: 'two_burgers' }, { silence: gap }, { say: 'no_wait_three', marker: `correction:late_${gap}` }, { quiet: 3500, maxMs: 30000 }],
  })),
  {
    name: 'correction_during_hold', description: 'user speaks the correction right after tool.call while the hold is artificially long',
    stubDelayMs: 2500,
    steps: [{ say: 'two_burgers' }, { until: 'tool_call', timeoutMs: 15000 }, { say: 'no_wait_three', marker: 'correction:during_hold' }, { quiet: 4000, maxMs: 30000 }],
  },
  {
    name: 'barge_in', description: 'user interrupts the agent mid-reply with a correction',
    steps: [{ say: 'clean' }, { until: 'reply_started', timeoutMs: 20000 }, { silence: 500 }, { say: 'no_wait_three_b', marker: 'correction:barge' }, { quiet: 4000, maxMs: 30000 }],
  },
  {
    name: 'backchannel', description: 'user says "uh-huh" while the agent is replying (must not interrupt)',
    steps: [{ say: 'two_burgers' }, { until: 'reply_started', timeoutMs: 20000 }, { silence: 300 }, { say: 'uhhuh' }, { quiet: 4000, maxMs: 30000 }],
  },
  {
    name: 'barge_in_speech', description: 'user interrupts the agent while it is genuinely SPEAKING (non-silent audio) with a correction',
    steps: [{ say: 'two_burgers' }, { untilAgentSpeech: 45000 }, { silence: 900 }, { say: 'no_wait_three_b', marker: 'correction:barge_speech' }, { quiet: 5000, maxMs: 45000 }],
  },
  {
    name: 'backchannel_speech', description: 'user says "uh-huh" while the agent is genuinely SPEAKING (must not interrupt)',
    steps: [{ say: 'two_burgers' }, { untilAgentSpeech: 45000 }, { silence: 900 }, { say: 'uhhuh' }, { quiet: 5000, maxMs: 45000 }],
  },
];
