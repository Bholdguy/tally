# Spike G5: generated analysis (machine output; a human verdict lives in docs/spike-g5.md)
Generated 2026-09-19T22:38:23.081Z from 16 captured run(s).

## Machine verdict: **FAIL** (suggested GATE_BUFFER_MS=1500)
- H1 FAIL: agent spoke before 26/26 mutating tool.call(s): hold mode does not keep the agent silent, so a confirmation can precede validation
- H3 BUFFER: 4/12 correction(s) were being spoken when tool.call arrived but their speech signal arrived after it; suggested GATE_BUFFER_MS=1500
- note: 1 correction-cue transcript(s) finalised after tool.result was sent (handled by re-validation on the next call, not by the buffer)
- H5 WARN: p95 silence (speech end → first agent audio) is 6876ms > 1500ms: demo may feel laggy

## Stats
```json
{
  "mutating_calls": 26,
  "corrections": 12,
  "blind_corrections": 4,
  "vad_lag_ms_p50": 1192.6551000000036,
  "vad_lag_ms_p95": 2724.973600000005,
  "silence_ms_p50": 2151.286400000001,
  "silence_ms_p95": 6875.524200000014,
  "hold_ms_p50": 0.6759000000020023,
  "barge_interrupts": 13,
  "barge_backchannels": 6,
  "interrupt_reaction_ms_p50": 0.36419999999998254,
  "tool_call_after_final_fraction": 0.6153846153846154
}
```

## Event ordering per scenario (client-stamped; audio/delta runs collapsed)
- **backchannel**: session.updated → session.ready → reply.started → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent → transcript.user.delta* → input.speech.started → reply.done → input.speech.stopped → transcript.agent → transcript.user → reply.started → reply.audio* → tool.call → reply.audio* → reply.done → reply.started → reply.audio* → input.speech.started → reply.audio* → input.speech.stopped → transcript.user → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent → reply.audio* → reply.done → reply.started → reply.done → reply.started → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent → transcript.agent.delta* → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent.delta* → reply.audio*
- **barge_in**: session.updated → session.ready → reply.started → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent → input.speech.started → reply.audio* → reply.done → transcript.user.delta* → input.speech.stopped → transcript.user → reply.started → reply.audio* → tool.call → reply.audio* → reply.done → reply.started → reply.audio* → input.speech.started → reply.audio* → transcript.user.delta* → reply.audio* → reply.done → reply.started → tool.call → reply.done → reply.started → reply.audio* → input.speech.stopped → reply.done → reply.started → reply.audio* → tool.call → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent → transcript.agent.delta* → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent.delta* → reply.audio*
- **clean_order**: session.updated → session.ready → reply.started → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent → transcript.user.delta* → input.speech.started → reply.done → transcript.user.delta* → input.speech.stopped → transcript.user → transcript.agent → reply.started → reply.audio* → tool.call → reply.audio* → reply.done → reply.started → reply.audio* → tool.call → reply.audio* → reply.done → reply.started → reply.audio* → tool.call → reply.audio* → transcript.agent.delta* → reply.audio*
- **correction_during_hold**: session.updated → session.ready → reply.started → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent → transcript.user.delta* → input.speech.started → reply.done → input.speech.stopped → transcript.agent → transcript.user → reply.started → reply.audio* → tool.call → reply.audio* → reply.done → input.speech.stopped → reply.started → reply.audio* → reply.done → reply.started → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent.delta* → reply.audio*
- **inline_correction**: session.updated → session.ready → reply.started → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent → transcript.user.delta* → input.speech.started → reply.done → transcript.user.delta* → input.speech.stopped → transcript.user → transcript.agent → reply.started → reply.audio* → tool.call → reply.audio* → reply.done → reply.started → reply.audio* → transcript.agent.delta* → reply.audio*
- **late_correction_1500ms**: session.updated → session.ready → reply.started → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent → transcript.user.delta* → input.speech.started → reply.done → input.speech.stopped → transcript.user → transcript.agent → reply.started → reply.audio* → tool.call → reply.audio* → reply.done → reply.started → reply.audio* → input.speech.started → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent → input.speech.started → reply.done → input.speech.stopped → transcript.user → reply.started → reply.audio* → tool.call → reply.audio* → reply.done → reply.started → reply.audio* → transcript.agent.delta* → reply.audio*
- **late_correction_400ms**: session.updated → session.ready → reply.started → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent.delta* → reply.audio* → input.speech.stopped → reply.audio* → transcript.user.delta* → transcript.user → reply.audio* → reply.done → reply.started → reply.audio* → input.speech.started → reply.audio* → tool.call → reply.audio* → reply.done → input.speech.stopped → reply.started → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent → reply.done → reply.started → reply.done → reply.started → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent → tool.call → reply.audio* → reply.done
- **late_correction_900ms**: session.updated → session.ready → reply.started → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent → input.speech.started → reply.done → input.speech.stopped → reply.started → reply.audio* → transcript.user → reply.audio* → input.speech.started → reply.audio* → reply.done → reply.started → tool.call → reply.done → input.speech.stopped → reply.started → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent → reply.done → reply.started → reply.done → reply.started → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent.delta* → reply.audio*

## Per-call facts
```json
[
 {
  "scenario": "backchannel",
  "calls": [],
  "corrections": [],
  "barge": []
 },
 {
  "scenario": "backchannel",
  "calls": [
   {
    "call_id": "chatcmpl-tool-8b1532d49870ce98",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 5198.862500000047,
    "hold_ms": 0.4469999999855645,
    "final_before_call": true,
    "stopped_to_call_ms": 1248.6169000000227,
    "spoke_before_call": true,
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [
     {
      "text": "Aha.",
      "after_call_ms": 1231.970399999991,
      "cue": false
     }
    ],
    "pause_after_result_ms": 3.9465000000200234,
    "silence_total_ms": 1253.0104000000283
   }
  ],
  "corrections": [],
  "barge": [
   {
    "kind": "interrupt",
    "speech_started_t": 3913.471300000034,
    "reply_done_t": 3913.588400000008,
    "reaction_ms": 0.1170999999740161
   },
   {
    "kind": "backchannel",
    "speech_started_t": 6020.933900000004,
    "reply_done_t": 8473.276100000017,
    "reaction_ms": null
   }
  ]
 },
 {
  "scenario": "barge_in",
  "calls": [
   {
    "call_id": "chatcmpl-tool-85220274b79a2907",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 8886.2647,
    "hold_ms": 0.32980000000679865,
    "final_before_call": false,
    "stopped_to_call_ms": 2257.2023000000045,
    "spoke_before_call": true,
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 0.37119999999413267,
    "silence_total_ms": 2257.9033000000054
   },
   {
    "call_id": "chatcmpl-tool-834f6224b1929ff1",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 11365.107499999984,
    "hold_ms": 0.23540000000502914,
    "final_before_call": false,
    "stopped_to_call_ms": 15.786499999987427,
    "spoke_before_call": true,
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 5.390500000008615,
    "silence_total_ms": 21.41240000000107
   },
   {
    "call_id": "chatcmpl-tool-ba3f1e74130c9ed0",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 12094.085699999996,
    "hold_ms": 0.4744000000064261,
    "final_before_call": false,
    "stopped_to_call_ms": 744.7646999999997,
    "spoke_before_call": true,
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 2.5652999999874737,
    "silence_total_ms": 747.8043999999936
   },
   {
    "call_id": "chatcmpl-tool-a5c7cad10e1ca371",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 13084.987599999993,
    "hold_ms": 1.3136999999987893,
    "final_before_call": false,
    "stopped_to_call_ms": 1735.6665999999968,
    "spoke_before_call": true,
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 2.619300000020303,
    "silence_total_ms": 1739.599600000016
   }
  ],
  "corrections": [
   {
    "label": "correction:barge",
    "t_marker_ms": 7461.309099999984,
    "vad_lag_ms": 1192.6551000000036,
    "final_lag_ms": null,
    "call_arrived_after_correction_began": true,
    "blind": false,
    "call_id": "chatcmpl-tool-85220274b79a2907"
   }
  ],
  "barge": [
   {
    "kind": "interrupt",
    "speech_started_t": 3996.1987999999837,
    "reply_done_t": 3996.236100000009,
    "reaction_ms": 0.037300000025425106
   },
   {
    "kind": "backchannel",
    "speech_started_t": 8653.964199999988,
    "reply_done_t": 10667.826700000005,
    "reaction_ms": null
   }
  ]
 },
 {
  "scenario": "barge_in",
  "calls": [
   {
    "call_id": "chatcmpl-tool-b9f4b1612af7eda1",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 7908.665299999993,
    "hold_ms": 0.4866000000038184,
    "final_before_call": true,
    "stopped_to_call_ms": 1432.8623999999836,
    "spoke_before_call": true,
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 0.6702999999979511,
    "silence_total_ms": 1434.0192999999854
   },
   {
    "call_id": "chatcmpl-tool-82ee07aa92ba85b9",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 10229.839899999992,
    "hold_ms": 0.3150000000023283,
    "final_before_call": false,
    "stopped_to_call_ms": 3754.036999999982,
    "spoke_before_call": true,
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 44.86960000000545,
    "silence_total_ms": 3799.22159999999
   },
   {
    "call_id": "chatcmpl-tool-a9a76ee26351d6a2",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 10887.690999999992,
    "hold_ms": 0.8215000000200234,
    "final_before_call": false,
    "stopped_to_call_ms": 9.81459999998333,
    "spoke_before_call": true,
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 3.883299999986775,
    "silence_total_ms": 14.519399999990128
   }
  ],
  "corrections": [
   {
    "label": "correction:barge",
    "t_marker_ms": 7013.922900000005,
    "vad_lag_ms": 1266.1455000000133,
    "final_lag_ms": null,
    "call_arrived_after_correction_began": true,
    "blind": true,
    "call_id": "chatcmpl-tool-b9f4b1612af7eda1"
   }
  ],
  "barge": [
   {
    "kind": "interrupt",
    "speech_started_t": 3953.389900000009,
    "reply_done_t": 3953.8446000000113,
    "reaction_ms": 0.4547000000020489
   },
   {
    "kind": "backchannel",
    "speech_started_t": 8280.068400000018,
    "reply_done_t": 9754.122900000017,
    "reaction_ms": null
   }
  ]
 },
 {
  "scenario": "clean_order",
  "calls": [
   {
    "call_id": "chatcmpl-tool-8f2051bb4c9172db",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 9789.6446,
    "hold_ms": 19.865700000000288,
    "final_before_call": true,
    "stopped_to_call_ms": 2130.0797000000002,
    "spoke_before_call": true,
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 1.3410000000003492,
    "silence_total_ms": 2151.286400000001
   },
   {
    "call_id": "chatcmpl-tool-b4ea2ea1dd70d0e6",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 12047.3939,
    "hold_ms": 99.84130000000005,
    "final_before_call": true,
    "stopped_to_call_ms": 4387.829,
    "spoke_before_call": true,
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 7.7018000000007305,
    "silence_total_ms": 4495.3721000000005
   },
   {
    "call_id": "chatcmpl-tool-926e96bea70db2da",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 13784.7604,
    "hold_ms": 3.1683000000011816,
    "final_before_call": true,
    "stopped_to_call_ms": 6125.1955,
    "spoke_before_call": true,
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 3.960799999998926,
    "silence_total_ms": 6132.3246
   }
  ],
  "corrections": [],
  "barge": [
   {
    "kind": "interrupt",
    "speech_started_t": 4717.982,
    "reply_done_t": 4719.68,
    "reaction_ms": 1.6980000000003201
   }
  ]
 },
 {
  "scenario": "clean_order",
  "calls": [
   {
    "call_id": "chatcmpl-tool-92a43fac450c534c",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 7686.5517,
    "hold_ms": 2.0674999999973807,
    "final_before_call": true,
    "stopped_to_call_ms": 1603.243400000003,
    "spoke_before_call": true,
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 0.4717000000018743,
    "silence_total_ms": 1605.7826000000023
   },
   {
    "call_id": "chatcmpl-tool-9837a4c9e7fa1fa3",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 10131.214899999999,
    "hold_ms": 1.3726999999998952,
    "final_before_call": true,
    "stopped_to_call_ms": 4047.906600000002,
    "spoke_before_call": true,
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 0.9775000000008731,
    "silence_total_ms": 4050.256800000003
   },
   {
    "call_id": "chatcmpl-tool-87b2cca811de54e9",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 10586.8229,
    "hold_ms": 0.9648999999990338,
    "final_before_call": true,
    "stopped_to_call_ms": 4503.514600000002,
    "spoke_before_call": true,
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 0.850800000000163,
    "silence_total_ms": 4505.330300000001
   }
  ],
  "corrections": [],
  "barge": [
   {
    "kind": "interrupt",
    "speech_started_t": 2998.7662999999993,
    "reply_done_t": 2999.1304999999993,
    "reaction_ms": 0.36419999999998254
   }
  ]
 },
 {
  "scenario": "correction_during_hold",
  "calls": [
   {
    "call_id": "chatcmpl-tool-b7b3c5e84c0d23db",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 5311.197400000005,
    "hold_ms": 2507.2385000000068,
    "final_before_call": true,
    "stopped_to_call_ms": 1472.4395000000077,
    "spoke_before_call": true,
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 2895.8462,
    "silence_total_ms": 6875.524200000014
   },
   {
    "call_id": "chatcmpl-tool-9915ebc52ac1ac7d",
    "tool": "update_quantity",
    "mutating": true,
    "t_call_ms": 15382.820299999992,
    "hold_ms": 2513.9138000000094,
    "final_before_call": true,
    "stopped_to_call_ms": 4670.034199999995,
    "spoke_before_call": true,
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 431.05749999999534,
    "silence_total_ms": 7615.005499999999
   }
  ],
  "corrections": [
   {
    "label": "correction:during_hold",
    "t_marker_ms": 5367.954399999988,
    "vad_lag_ms": null,
    "final_lag_ms": null,
    "call_arrived_after_correction_began": true,
    "blind": true,
    "call_id": "chatcmpl-tool-9915ebc52ac1ac7d"
   }
  ],
  "barge": []
 },
 {
  "scenario": "correction_during_hold",
  "calls": [
   {
    "call_id": "chatcmpl-tool-bcf32c232b9b45bf",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 4974.036800000002,
    "hold_ms": 2507.736200000014,
    "final_before_call": true,
    "stopped_to_call_ms": 1229.4563999999955,
    "spoke_before_call": true,
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 2807.385099999985,
    "silence_total_ms": 6544.577699999994
   }
  ],
  "corrections": [
   {
    "label": "correction:during_hold",
    "t_marker_ms": 5022.067800000019,
    "vad_lag_ms": null,
    "final_lag_ms": null,
    "call_arrived_after_correction_began": false,
    "blind": false,
    "call_id": null
   }
  ],
  "barge": [
   {
    "kind": "interrupt",
    "speech_started_t": 3732.623100000026,
    "reply_done_t": 3733.0036000000255,
    "reaction_ms": 0.3804999999993015
   }
  ]
 },
 {
  "scenario": "inline_correction",
  "calls": [
   {
    "call_id": "chatcmpl-tool-9b5a65d56c0e2a20",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 11537.612799999999,
    "hold_ms": 0.6067000000039116,
    "final_before_call": true,
    "stopped_to_call_ms": 3349.6728999999978,
    "spoke_before_call": true,
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 0.16119999999500578,
    "silence_total_ms": 3350.4407999999967
   }
  ],
  "corrections": [
   {
    "label": "correction:inline",
    "t_marker_ms": 2050.922300000002,
    "vad_lag_ms": 1564.830799999996,
    "final_lag_ms": 6137.5605,
    "call_arrived_after_correction_began": true,
    "blind": false,
    "call_id": "chatcmpl-tool-9b5a65d56c0e2a20"
   }
  ],
  "barge": [
   {
    "kind": "interrupt",
    "speech_started_t": 3615.753099999998,
    "reply_done_t": 3616.939000000002,
    "reaction_ms": 1.1859000000040396
   }
  ]
 },
 {
  "scenario": "inline_correction",
  "calls": [
   {
    "call_id": "chatcmpl-tool-b2663dc8fc0b3cb9",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 11630.894499999995,
    "hold_ms": 0.3717000000033295,
    "final_before_call": true,
    "stopped_to_call_ms": 3064.4612999999954,
    "spoke_before_call": true,
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 137.01209999999992,
    "silence_total_ms": 3201.8450999999986
   }
  ],
  "corrections": [
   {
    "label": "correction:inline",
    "t_marker_ms": 2490.883299999994,
    "vad_lag_ms": 2724.973600000005,
    "final_lag_ms": 6079.9136,
    "call_arrived_after_correction_began": true,
    "blind": false,
    "call_id": "chatcmpl-tool-b2663dc8fc0b3cb9"
   }
  ],
  "barge": [
   {
    "kind": "interrupt",
    "speech_started_t": 5215.856899999999,
    "reply_done_t": 5215.942999999999,
    "reaction_ms": 0.08610000000044238
   }
  ]
 },
 {
  "scenario": "late_correction_1500ms",
  "calls": [
   {
    "call_id": "chatcmpl-tool-927bf5c8bc2ba643",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 7140.698999999993,
    "hold_ms": 0.7899000000033993,
    "final_before_call": true,
    "stopped_to_call_ms": 1930.1633999999904,
    "spoke_before_call": true,
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 0.8581999999878462,
    "silence_total_ms": 1931.8114999999816
   }
  ],
  "corrections": [
   {
    "label": "correction:late_1500",
    "t_marker_ms": 6185.631400000013,
    "vad_lag_ms": null,
    "final_lag_ms": null,
    "call_arrived_after_correction_began": true,
    "blind": true,
    "call_id": "chatcmpl-tool-927bf5c8bc2ba643"
   }
  ],
  "barge": []
 },
 {
  "scenario": "late_correction_1500ms",
  "calls": [
   {
    "call_id": "chatcmpl-tool-b42dbfe366e38e93",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 4775.916299999983,
    "hold_ms": 0.6759000000020023,
    "final_before_call": true,
    "stopped_to_call_ms": 1143.4784999999974,
    "spoke_before_call": true,
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [
     {
      "text": "No, wait, make it 3.",
      "after_call_ms": 4706.124899999995,
      "cue": true
     }
    ],
    "pause_after_result_ms": 7.811799999995856,
    "silence_total_ms": 1151.9661999999953
   },
   {
    "call_id": "chatcmpl-tool-8cb4864d7cf9a84e",
    "tool": "update_quantity",
    "mutating": true,
    "t_call_ms": 11126.959600000002,
    "hold_ms": 0.6001999999862164,
    "final_before_call": true,
    "stopped_to_call_ms": 1645.0570000000007,
    "spoke_before_call": true,
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 0.4441999999980908,
    "silence_total_ms": 1646.101399999985
   }
  ],
  "corrections": [
   {
    "label": "correction:late_1500",
    "t_marker_ms": 4544.508999999991,
    "vad_lag_ms": 1028.1019000000088,
    "final_lag_ms": 4937.532199999987,
    "call_arrived_after_correction_began": true,
    "blind": true,
    "call_id": "chatcmpl-tool-b42dbfe366e38e93"
   }
  ],
  "barge": [
   {
    "kind": "interrupt",
    "speech_started_t": 3004.8859999999986,
    "reply_done_t": 3007.4147999999986,
    "reaction_ms": 2.5288000000000466
   },
   {
    "kind": "interrupt",
    "speech_started_t": 5572.6109,
    "reply_done_t": 9136.98999999999,
    "reaction_ms": 3564.379099999991
   },
   {
    "kind": "interrupt",
    "speech_started_t": 9136.94749999998,
    "reply_done_t": 9136.98999999999,
    "reaction_ms": 0.04250000001047738
   }
  ]
 },
 {
  "scenario": "late_correction_400ms",
  "calls": [
   {
    "call_id": "chatcmpl-tool-8e10b3190fc630de",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 6366.237399999998,
    "hold_ms": 0.3378999999986263,
    "final_before_call": false,
    "stopped_to_call_ms": 702.0448000000033,
    "spoke_before_call": true,
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 4.555800000001909,
    "silence_total_ms": 706.9385000000038
   }
  ],
  "corrections": [
   {
    "label": "correction:late_400",
    "t_marker_ms": 4467.736499999999,
    "vad_lag_ms": 1505.5933000000077,
    "final_lag_ms": 1210.9600999999966,
    "call_arrived_after_correction_began": true,
    "blind": false,
    "call_id": "chatcmpl-tool-8e10b3190fc630de"
   }
  ],
  "barge": [
   {
    "kind": "backchannel",
    "speech_started_t": 5973.329800000007,
    "reply_done_t": 6546.814899999998,
    "reaction_ms": null
   }
  ]
 },
 {
  "scenario": "late_correction_400ms",
  "calls": [
   {
    "call_id": "chatcmpl-tool-990bcbf77e07cbb4",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 5782.951700000005,
    "hold_ms": 0.6024999999935972,
    "final_before_call": false,
    "stopped_to_call_ms": 1422.209600000002,
    "spoke_before_call": true,
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 8.34309999999823,
    "silence_total_ms": 1431.1551999999938
   },
   {
    "call_id": "chatcmpl-tool-81953241e0f180e6",
    "tool": "update_quantity",
    "mutating": true,
    "t_call_ms": 14980.094800000006,
    "hold_ms": 0.8298999999969965,
    "final_before_call": false,
    "stopped_to_call_ms": 5756.688300000009,
    "spoke_before_call": true,
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 0.7736999999906402,
    "silence_total_ms": 5758.2918999999965
   }
  ],
  "corrections": [
   {
    "label": "correction:late_400",
    "t_marker_ms": 4122.068700000003,
    "vad_lag_ms": 985.944399999993,
    "final_lag_ms": 344.43940000000293,
    "call_arrived_after_correction_began": true,
    "blind": false,
    "call_id": "chatcmpl-tool-990bcbf77e07cbb4"
   }
  ],
  "barge": [
   {
    "kind": "backchannel",
    "speech_started_t": 5108.0130999999965,
    "reply_done_t": 5869.004700000005,
    "reaction_ms": null
   }
  ]
 },
 {
  "scenario": "late_correction_900ms",
  "calls": [],
  "corrections": [
   {
    "label": "correction:late_900",
    "t_marker_ms": 5572.760399999999,
    "vad_lag_ms": null,
    "final_lag_ms": null,
    "call_arrived_after_correction_began": false,
    "blind": false,
    "call_id": null
   }
  ],
  "barge": [
   {
    "kind": "interrupt",
    "speech_started_t": 5362.3531000000075,
    "reply_done_t": 5362.414400000009,
    "reaction_ms": 0.06130000000121072
   }
  ]
 },
 {
  "scenario": "late_correction_900ms",
  "calls": [
   {
    "call_id": "chatcmpl-tool-aee45b6773cd1f22",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 12100.934899999993,
    "hold_ms": 0.3301999999966938,
    "final_before_call": false,
    "stopped_to_call_ms": 1590.1686999999947,
    "spoke_before_call": true,
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 3353.0188000000053,
    "silence_total_ms": 4943.517699999997
   }
  ],
  "corrections": [
   {
    "label": "correction:late_900",
    "t_marker_ms": 10007.771500000003,
    "vad_lag_ms": 502.7526999999973,
    "final_lag_ms": 697.9523999999947,
    "call_arrived_after_correction_began": true,
    "blind": false,
    "call_id": "chatcmpl-tool-aee45b6773cd1f22"
   }
  ],
  "barge": [
   {
    "kind": "interrupt",
    "speech_started_t": 10510.5242,
    "reply_done_t": 10510.65939999999,
    "reaction_ms": 0.13519999998970889
   },
   {
    "kind": "backchannel",
    "speech_started_t": 11649.74519999999,
    "reply_done_t": 12100.85639999999,
    "reaction_ms": null
   }
  ]
 }
]
```