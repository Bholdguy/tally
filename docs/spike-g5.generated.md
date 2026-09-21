# Spike G5: generated analysis (machine output; a human verdict lives in docs/spike-g5.md)
Generated 2026-09-19T22:54:57.097Z from 20 captured run(s).

## Machine verdict: **FAIL** (suggested GATE_BUFFER_MS=2250)
- H1 FAIL: agent spoke before 3/33 mutating tool.call(s): hold mode does not keep the agent silent, so a confirmation can precede validation
- H3 BUFFER: 3/14 correction(s) were being spoken when tool.call arrived but their speech signal arrived after it; suggested GATE_BUFFER_MS=2250
- note: 2 correction-cue transcript(s) finalised after tool.result was sent (handled by re-validation on the next call, not by the buffer)
- H5 WARN: p95 silence (speech end → first agent audio) is 8379ms > 1500ms: demo may feel laggy

## Stats
```json
{
  "mutating_calls": 33,
  "corrections": 14,
  "blind_corrections": 3,
  "vad_lag_ms_p50": 1756.2831000000006,
  "vad_lag_ms_p95": 3022.7796,
  "silence_ms_p50": 2683.3943,
  "silence_ms_p95": 8379.381099999999,
  "hold_ms_p50": 0.7151000000303611,
  "barge_interrupts": 2,
  "barge_backchannels": 0,
  "interrupt_reaction_ms_p50": 0.06899999999586726,
  "tool_call_after_final_fraction": 0.6666666666666666
}
```

## Event ordering per scenario (client-stamped; audio/delta runs collapsed)
- **backchannel**: session.updated → session.ready → reply.started → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent → reply.audio* → reply.done → input.speech.started → transcript.user.delta* → input.speech.stopped → transcript.user → reply.started → reply.audio* → tool.call → reply.audio* → reply.done → reply.started → reply.audio* → input.speech.started → reply.audio* → input.speech.stopped → transcript.user → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent → reply.audio* → reply.done → reply.started → reply.audio* → transcript.agent.delta* → reply.audio*
- **backchannel_speech**: session.updated → session.ready → reply.started → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent → reply.audio* → reply.done → input.speech.started → transcript.user.delta* → input.speech.stopped → transcript.user → reply.started → reply.audio* → tool.call → reply.audio* → reply.done → reply.started → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent → reply.audio* → reply.done → input.speech.started → transcript.user.delta* → input.speech.stopped → transcript.user → reply.started → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent.delta* → reply.audio*
- **barge_in**: session.updated → session.ready → reply.started → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent → reply.audio* → reply.done → input.speech.started → transcript.user.delta* → input.speech.stopped → transcript.user → reply.started → reply.audio* → tool.call → reply.audio* → reply.done → reply.started → reply.audio* → input.speech.started → reply.audio* → reply.done → reply.started → tool.call → reply.done → reply.started → reply.audio* → input.speech.stopped → reply.done → reply.started → reply.audio* → tool.call → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent → reply.done → reply.started → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent.delta* → reply.audio*
- **barge_in_speech**: session.updated → session.ready → reply.started → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent → reply.audio* → reply.done → input.speech.started → transcript.user.delta* → transcript.user → reply.started → input.speech.stopped → reply.audio* → tool.call → reply.audio* → reply.done → reply.started → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent → input.speech.started → reply.done → transcript.user.delta* → input.speech.stopped → transcript.user → reply.started → reply.audio* → tool.call → reply.audio* → reply.done → reply.started → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent → reply.audio* → reply.done
- **clean_order**: session.updated → session.ready → reply.started → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent → reply.audio* → reply.done → input.speech.started → transcript.user.delta* → input.speech.stopped → transcript.user → reply.started → reply.audio* → tool.call → reply.audio* → reply.done → reply.started → reply.audio* → tool.call → reply.audio* → reply.done → reply.started → reply.audio* → tool.call → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent.delta* → reply.audio*
- **correction_during_hold**: session.updated → session.ready → reply.started → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent → reply.audio* → reply.done → input.speech.started → transcript.user.delta* → input.speech.stopped → transcript.user → reply.started → reply.audio* → tool.call → reply.audio* → reply.done → input.speech.stopped → reply.started → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent → reply.audio* → reply.done → reply.started → reply.done → reply.started → reply.audio* → transcript.agent.delta* → reply.audio*
- **inline_correction**: session.updated → session.ready → reply.started → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent → reply.audio* → reply.done → input.speech.started → transcript.user.delta* → input.speech.stopped → transcript.user → reply.started → reply.audio* → tool.call → reply.audio* → reply.done → reply.started → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent.delta* → reply.audio*
- **late_correction_1500ms**: session.updated → session.ready → reply.started → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent → reply.audio* → reply.done → input.speech.started → transcript.user.delta* → input.speech.stopped → transcript.user → reply.started → reply.audio* → input.speech.started → reply.audio* → tool.call → reply.audio* → reply.done → input.speech.stopped → reply.started → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent → reply.done → reply.started → reply.done → reply.started → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent → reply.audio* → tool.call → reply.audio* → reply.done → reply.started → reply.audio* → transcript.agent.delta* → reply.audio*
- **late_correction_400ms**: session.updated → session.ready → reply.started → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent → reply.audio* → reply.done → input.speech.started → transcript.user.delta* → input.speech.stopped → transcript.user → reply.started → reply.audio* → input.speech.started → reply.audio* → reply.done → reply.started → tool.call → reply.done → input.speech.stopped → reply.started → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent → reply.done → reply.started → reply.done → reply.started → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent.delta* → reply.audio*
- **late_correction_900ms**: session.updated → session.ready → reply.started → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent → reply.audio* → reply.done → input.speech.started → transcript.user.delta* → transcript.user → reply.started → input.speech.stopped → reply.audio* → input.speech.started → reply.audio* → reply.done → reply.started → tool.call → reply.done → input.speech.stopped → reply.started → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent → reply.audio* → reply.done → reply.started → reply.done → reply.started → reply.audio* → transcript.agent.delta* → reply.audio* → transcript.agent.delta* → reply.audio*

## Per-call facts
```json
[
 {
  "scenario": "backchannel",
  "calls": [
   {
    "call_id": "chatcmpl-tool-be6095ffba688f29",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 10584.48550000001,
    "hold_ms": 0.3252999999676831,
    "final_before_call": true,
    "stopped_to_call_ms": 2075.5708999999915,
    "spoke_before_call": false,
    "silent_audio_before_call_ms": 2080,
    "loud_audio_before_call_ms": 0,
    "args": {
     "item_id": "burger",
     "modifiers": [],
     "quantity": 2
    },
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [
     {
      "text": "Aha.",
      "after_call_ms": 920.3635999999824,
      "cue": false
     }
    ],
    "pause_after_result_ms": 7.766100000008009,
    "silence_total_ms": 2083.662299999967
   }
  ],
  "corrections": [],
  "barge": []
 },
 {
  "scenario": "backchannel",
  "calls": [
   {
    "call_id": "chatcmpl-tool-a3141ce18f2700ec",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 10608.256099999999,
    "hold_ms": 0.20079999999143183,
    "final_before_call": true,
    "stopped_to_call_ms": 1955.9679999999935,
    "spoke_before_call": false,
    "silent_audio_before_call_ms": 1970,
    "loud_audio_before_call_ms": 0,
    "args": {
     "item_id": "burger",
     "modifiers": [],
     "quantity": 2
    },
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [
     {
      "text": "Aha.",
      "after_call_ms": 927.7000999999582,
      "cue": false
     }
    ],
    "pause_after_result_ms": 0.34429999999701977,
    "silence_total_ms": 1956.513099999982
   }
  ],
  "corrections": [],
  "barge": []
 },
 {
  "scenario": "backchannel_speech",
  "calls": [
   {
    "call_id": "chatcmpl-tool-88a8223158cdcf86",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 10366.815599999994,
    "hold_ms": 0.37680000001273584,
    "final_before_call": true,
    "stopped_to_call_ms": 1918.5552999999927,
    "spoke_before_call": false,
    "silent_audio_before_call_ms": 1920,
    "loud_audio_before_call_ms": 0,
    "args": {
     "item_id": "burger",
     "modifiers": [],
     "quantity": 2
    },
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [
     {
      "text": "Aha.",
      "after_call_ms": 6644.849000000002,
      "cue": false
     }
    ],
    "pause_after_result_ms": 8.731099999989965,
    "silence_total_ms": 1927.6631999999954
   }
  ],
  "corrections": [],
  "barge": []
 },
 {
  "scenario": "backchannel_speech",
  "calls": [
   {
    "call_id": "chatcmpl-tool-9c875c7ce067406c",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 10735.073000000004,
    "hold_ms": 1.1913000000058673,
    "final_before_call": true,
    "stopped_to_call_ms": 2239.6619999999966,
    "spoke_before_call": false,
    "silent_audio_before_call_ms": 2230,
    "loud_audio_before_call_ms": 0,
    "args": {
     "item_id": "burger",
     "modifiers": [],
     "quantity": 2
    },
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [
     {
      "text": "Aha.",
      "after_call_ms": 6058.653099999996,
      "cue": false
     }
    ],
    "pause_after_result_ms": 1.9897999999957392,
    "silence_total_ms": 2242.8430999999982
   }
  ],
  "corrections": [],
  "barge": []
 },
 {
  "scenario": "barge_in",
  "calls": [
   {
    "call_id": "chatcmpl-tool-a85c630cd2b6c333",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 13016.242099999974,
    "hold_ms": 0.7151000000303611,
    "final_before_call": true,
    "stopped_to_call_ms": 1524.3387999999686,
    "spoke_before_call": false,
    "silent_audio_before_call_ms": 1410,
    "loud_audio_before_call_ms": 0,
    "args": {
     "item_id": "burger",
     "modifiers": [],
     "quantity": 2
    },
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 1.8227999999653548,
    "silence_total_ms": 1526.8766999999643
   },
   {
    "call_id": "chatcmpl-tool-b6cee8455f130d91",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 15186.753399999987,
    "hold_ms": 0.323900000017602,
    "final_before_call": false,
    "stopped_to_call_ms": 3694.8500999999815,
    "spoke_before_call": false,
    "silent_audio_before_call_ms": 3480,
    "loud_audio_before_call_ms": 0,
    "args": {
     "item_id": "coke",
     "modifiers": [],
     "quantity": 1
    },
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 75.80979999998817,
    "silence_total_ms": 3770.9837999999872
   },
   {
    "call_id": "chatcmpl-tool-89efe0f1a57c7d93",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 17158.49650000001,
    "hold_ms": 3.1459000000031665,
    "final_before_call": false,
    "stopped_to_call_ms": 502.91340000001946,
    "spoke_before_call": false,
    "silent_audio_before_call_ms": 500,
    "loud_audio_before_call_ms": 0,
    "args": {
     "item_id": "coke",
     "modifiers": [
      "size_large"
     ],
     "quantity": 1
    },
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 1.1570999999530613,
    "silence_total_ms": 507.2163999999757
   }
  ],
  "corrections": [
   {
    "label": "correction:barge",
    "t_marker_ms": 12021.949199999974,
    "vad_lag_ms": 2034.0265000000363,
    "final_lag_ms": null,
    "call_arrived_after_correction_began": true,
    "blind": true,
    "call_id": "chatcmpl-tool-a85c630cd2b6c333"
   }
  ],
  "barge": []
 },
 {
  "scenario": "barge_in",
  "calls": [
   {
    "call_id": "chatcmpl-tool-958675fb84bdbeda",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 12929.556700000016,
    "hold_ms": 0.4140999999945052,
    "final_before_call": true,
    "stopped_to_call_ms": 1394.553899999999,
    "spoke_before_call": false,
    "silent_audio_before_call_ms": 1400,
    "loud_audio_before_call_ms": 0,
    "args": {
     "item_id": "burger",
     "modifiers": [],
     "quantity": 2
    },
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 0.4086000000243075,
    "silence_total_ms": 1395.3766000000178
   },
   {
    "call_id": "chatcmpl-tool-a17b7b52ef4d289c",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 15358.871299999999,
    "hold_ms": 0.48790000000735745,
    "final_before_call": false,
    "stopped_to_call_ms": 3823.8684999999823,
    "spoke_before_call": false,
    "silent_audio_before_call_ms": 3390,
    "loud_audio_before_call_ms": 0,
    "args": {
     "item_id": "coke",
     "modifiers": [],
     "quantity": 1
    },
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 67.51240000000689,
    "silence_total_ms": 3891.8687999999966
   },
   {
    "call_id": "chatcmpl-tool-91e8f6ea258e6f66",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 17335.91730000003,
    "hold_ms": 0.30779999995138496,
    "final_before_call": false,
    "stopped_to_call_ms": 500.2296000000206,
    "spoke_before_call": false,
    "silent_audio_before_call_ms": 500,
    "loud_audio_before_call_ms": 0,
    "args": {
     "item_id": "coke",
     "modifiers": [
      "size_large"
     ],
     "quantity": 1
    },
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 5.5560000000405125,
    "silence_total_ms": 506.0934000000125
   }
  ],
  "corrections": [
   {
    "label": "correction:barge",
    "t_marker_ms": 12091.500400000019,
    "vad_lag_ms": 2042.6742000000086,
    "final_lag_ms": null,
    "call_arrived_after_correction_began": true,
    "blind": true,
    "call_id": "chatcmpl-tool-958675fb84bdbeda"
   }
  ],
  "barge": []
 },
 {
  "scenario": "barge_in_speech",
  "calls": [
   {
    "call_id": "chatcmpl-tool-98609827ed9b09ec",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 10687.633399999999,
    "hold_ms": 8.109200000000783,
    "final_before_call": true,
    "stopped_to_call_ms": 1901.0630999999994,
    "spoke_before_call": false,
    "silent_audio_before_call_ms": 1900,
    "loud_audio_before_call_ms": 0,
    "args": {
     "item_id": "burger",
     "modifiers": [],
     "quantity": 2
    },
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [
     {
      "text": "No, wait, make it 3 burgers.",
      "after_call_ms": 8314.835200000001,
      "cue": true
     }
    ],
    "pause_after_result_ms": 1.6358000000000175,
    "silence_total_ms": 1910.8081000000002
   },
   {
    "call_id": "chatcmpl-tool-8be09371a45d9809",
    "tool": "update_quantity",
    "mutating": true,
    "t_call_ms": 20615.5902,
    "hold_ms": 1.7148999999990338,
    "final_before_call": true,
    "stopped_to_call_ms": 1613.3204000000005,
    "spoke_before_call": false,
    "silent_audio_before_call_ms": 1570,
    "loud_audio_before_call_ms": 0,
    "args": {
     "item_id": "burger",
     "quantity": 3
    },
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 0.4462000000021362,
    "silence_total_ms": 1615.4815000000017
   }
  ],
  "corrections": [
   {
    "label": "correction:barge_speech",
    "t_marker_ms": 13966.7433,
    "vad_lag_ms": 3022.7796,
    "final_lag_ms": 5035.7253,
    "call_arrived_after_correction_began": true,
    "blind": false,
    "call_id": "chatcmpl-tool-8be09371a45d9809"
   }
  ],
  "barge": [
   {
    "kind": "interrupt",
    "speech_started_t": 16989.5229,
    "reply_done_t": 16989.5992,
    "reaction_ms": 0.07630000000062864
   }
  ]
 },
 {
  "scenario": "barge_in_speech",
  "calls": [
   {
    "call_id": "chatcmpl-tool-91c919987e706264",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 11005.775699999998,
    "hold_ms": 1.4856999999974505,
    "final_before_call": true,
    "stopped_to_call_ms": 2078.5170999999973,
    "spoke_before_call": false,
    "silent_audio_before_call_ms": 2040,
    "loud_audio_before_call_ms": 0,
    "args": {
     "item_id": "burger",
     "modifiers": [],
     "quantity": 2
    },
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [
     {
      "text": "No, wait, make it 3 burgers.",
      "after_call_ms": 7820.006000000001,
      "cue": true
     }
    ],
    "pause_after_result_ms": 0.9003000000011525,
    "silence_total_ms": 2080.903099999996
   },
   {
    "call_id": "chatcmpl-tool-914f9a849c332366",
    "tool": "update_quantity",
    "mutating": true,
    "t_call_ms": 20538.9871,
    "hold_ms": 0.4666999999972177,
    "final_before_call": true,
    "stopped_to_call_ms": 1713.2770000000019,
    "spoke_before_call": false,
    "silent_audio_before_call_ms": 1710,
    "loud_audio_before_call_ms": 0,
    "args": {
     "item_id": "burger",
     "quantity": 3
    },
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 9.325000000004366,
    "silence_total_ms": 1723.0687000000034
   }
  ],
  "corrections": [
   {
    "label": "correction:barge_speech",
    "t_marker_ms": 13735.723999999995,
    "vad_lag_ms": 2717.516500000005,
    "final_lag_ms": 5090.057700000005,
    "call_arrived_after_correction_began": true,
    "blind": false,
    "call_id": "chatcmpl-tool-914f9a849c332366"
   }
  ],
  "barge": [
   {
    "kind": "interrupt",
    "speech_started_t": 16453.2405,
    "reply_done_t": 16453.309499999996,
    "reaction_ms": 0.06899999999586726
   }
  ]
 },
 {
  "scenario": "clean_order",
  "calls": [
   {
    "call_id": "chatcmpl-tool-8624710a465e6953",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 12531.738899999998,
    "hold_ms": 5.547200000000885,
    "final_before_call": true,
    "stopped_to_call_ms": 1487.4134999999987,
    "spoke_before_call": false,
    "silent_audio_before_call_ms": 1470,
    "loud_audio_before_call_ms": 0,
    "args": {
     "item_id": "burger",
     "modifiers": [],
     "quantity": 2
    },
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 0.47810000000026776,
    "silence_total_ms": 1493.4388
   },
   {
    "call_id": "chatcmpl-tool-ac4632cd860e697f",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 14952.236299999999,
    "hold_ms": 48.82550000000083,
    "final_before_call": true,
    "stopped_to_call_ms": 3907.910899999999,
    "spoke_before_call": false,
    "silent_audio_before_call_ms": 3900,
    "loud_audio_before_call_ms": 0,
    "args": {
     "item_id": "coke",
     "modifiers": [],
     "quantity": 1
    },
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 0.3058000000000902,
    "silence_total_ms": 3957.0422
   },
   {
    "call_id": "chatcmpl-tool-aa8b535236d2163e",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 15572.502799999998,
    "hold_ms": 1.01759999999922,
    "final_before_call": true,
    "stopped_to_call_ms": 4528.177399999999,
    "spoke_before_call": false,
    "silent_audio_before_call_ms": 4520,
    "loud_audio_before_call_ms": 0,
    "args": {
     "item_id": "coke",
     "modifiers": [],
     "quantity": 1
    },
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 2.6900000000023283,
    "silence_total_ms": 4531.885
   }
  ],
  "corrections": [],
  "barge": []
 },
 {
  "scenario": "clean_order",
  "calls": [
   {
    "call_id": "chatcmpl-tool-8fd11364d484d852",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 12201.856000000003,
    "hold_ms": 0.49940000000060536,
    "final_before_call": true,
    "stopped_to_call_ms": 1161.8128000000033,
    "spoke_before_call": false,
    "silent_audio_before_call_ms": 1420,
    "loud_audio_before_call_ms": 0,
    "args": {
     "item_id": "burger",
     "modifiers": [],
     "quantity": 2
    },
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 0.38699999999516876,
    "silence_total_ms": 1162.699199999999
   },
   {
    "call_id": "chatcmpl-tool-9d9029f68b68edab",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 14620.216400000001,
    "hold_ms": 0.7542000000030384,
    "final_before_call": true,
    "stopped_to_call_ms": 3580.173200000001,
    "spoke_before_call": false,
    "silent_audio_before_call_ms": 3840,
    "loud_audio_before_call_ms": 0,
    "args": {
     "item_id": "coke",
     "modifiers": [],
     "quantity": 1
    },
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 2.957799999996496,
    "silence_total_ms": 3583.8852000000006
   },
   {
    "call_id": "chatcmpl-tool-b8aba4beed2b23fb",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 15246.422300000002,
    "hold_ms": 0.5764999999955762,
    "final_before_call": true,
    "stopped_to_call_ms": 4206.379100000002,
    "spoke_before_call": false,
    "silent_audio_before_call_ms": 4470,
    "loud_audio_before_call_ms": 0,
    "args": {
     "item_id": "coke",
     "modifiers": [],
     "quantity": 1
    },
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 7.852600000005623,
    "silence_total_ms": 4214.808200000003
   }
  ],
  "corrections": [],
  "barge": []
 },
 {
  "scenario": "correction_during_hold",
  "calls": [
   {
    "call_id": "chatcmpl-tool-b1eadddd7d3201a7",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 10944.222000000009,
    "hold_ms": 2500.4437000000034,
    "final_before_call": true,
    "stopped_to_call_ms": 2139.250800000009,
    "spoke_before_call": false,
    "silent_audio_before_call_ms": 2090,
    "loud_audio_before_call_ms": 0,
    "args": {
     "item_id": "burger",
     "modifiers": [],
     "quantity": 2
    },
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 3739.6865999999864,
    "silence_total_ms": 8379.381099999999
   },
   {
    "call_id": "chatcmpl-tool-962144f13508ab6a",
    "tool": "update_quantity",
    "mutating": true,
    "t_call_ms": 23018.4675,
    "hold_ms": 2509.678600000014,
    "final_before_call": true,
    "stopped_to_call_ms": 5839.1393999999855,
    "spoke_before_call": true,
    "silent_audio_before_call_ms": 3180,
    "loud_audio_before_call_ms": 2450,
    "args": {
     "item_id": "burger",
     "quantity": 3
    },
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 442.67619999998715,
    "silence_total_ms": 8791.494199999986
   }
  ],
  "corrections": [
   {
    "label": "correction:during_hold",
    "t_marker_ms": 10991.701000000001,
    "vad_lag_ms": null,
    "final_lag_ms": null,
    "call_arrived_after_correction_began": true,
    "blind": true,
    "call_id": "chatcmpl-tool-962144f13508ab6a"
   }
  ],
  "barge": []
 },
 {
  "scenario": "correction_during_hold",
  "calls": [
   {
    "call_id": "chatcmpl-tool-a6789475fee32d9b",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 10600.621599999984,
    "hold_ms": 2503.6701000000176,
    "final_before_call": true,
    "stopped_to_call_ms": 2007.3717999999935,
    "spoke_before_call": false,
    "silent_audio_before_call_ms": 1960,
    "loud_audio_before_call_ms": 0,
    "args": {
     "item_id": "burger",
     "modifiers": [],
     "quantity": 2
    },
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 3775.7932999999903,
    "silence_total_ms": 8286.835200000001
   }
  ],
  "corrections": [
   {
    "label": "correction:during_hold",
    "t_marker_ms": 10627.3131,
    "vad_lag_ms": null,
    "final_lag_ms": null,
    "call_arrived_after_correction_began": false,
    "blind": false,
    "call_id": null
   }
  ],
  "barge": []
 },
 {
  "scenario": "inline_correction",
  "calls": [
   {
    "call_id": "chatcmpl-tool-bb9a690ac7b02df3",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 16584.525100000006,
    "hold_ms": 0.6146000000007916,
    "final_before_call": true,
    "stopped_to_call_ms": 2977.035300000003,
    "spoke_before_call": false,
    "silent_audio_before_call_ms": 2820,
    "loud_audio_before_call_ms": 0,
    "args": {
     "item_id": "burger",
     "modifiers": [],
     "quantity": 3
    },
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 8.91189999999915,
    "silence_total_ms": 2986.561800000003
   }
  ],
  "corrections": [
   {
    "label": "correction:inline",
    "t_marker_ms": 6158.286600000007,
    "vad_lag_ms": 2096.095499999996,
    "final_lag_ms": 7449.4547999999995,
    "call_arrived_after_correction_began": true,
    "blind": false,
    "call_id": "chatcmpl-tool-bb9a690ac7b02df3"
   }
  ],
  "barge": []
 },
 {
  "scenario": "inline_correction",
  "calls": [
   {
    "call_id": "chatcmpl-tool-9f0384ae05475da6",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 17264.0668,
    "hold_ms": 0.8332999999984168,
    "final_before_call": true,
    "stopped_to_call_ms": 2857.353999999992,
    "spoke_before_call": false,
    "silent_audio_before_call_ms": 2860,
    "loud_audio_before_call_ms": 0,
    "args": {
     "item_id": "burger",
     "modifiers": [],
     "quantity": 3
    },
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 0.7494000000006054,
    "silence_total_ms": 2858.936699999991
   }
  ],
  "corrections": [
   {
    "label": "correction:inline",
    "t_marker_ms": 7840.128899999996,
    "vad_lag_ms": 1532.2518000000127,
    "final_lag_ms": 6566.892800000001,
    "call_arrived_after_correction_began": true,
    "blind": false,
    "call_id": "chatcmpl-tool-9f0384ae05475da6"
   }
  ],
  "barge": []
 },
 {
  "scenario": "late_correction_1500ms",
  "calls": [
   {
    "call_id": "chatcmpl-tool-9fe75a4d6b1f4552",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 10095.085500000016,
    "hold_ms": 0.5029999999969732,
    "final_before_call": false,
    "stopped_to_call_ms": 1917.078600000008,
    "spoke_before_call": false,
    "silent_audio_before_call_ms": 1910,
    "loud_audio_before_call_ms": 0,
    "args": {
     "item_id": "burger",
     "modifiers": [],
     "quantity": 2
    },
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 0.8160999999963678,
    "silence_total_ms": 1918.3977000000014
   },
   {
    "call_id": "chatcmpl-tool-a5887ba8dab9fcb6",
    "tool": "update_quantity",
    "mutating": true,
    "t_call_ms": 18762.180699999997,
    "hold_ms": 1.584900000016205,
    "final_before_call": false,
    "stopped_to_call_ms": 4610.247199999983,
    "spoke_before_call": true,
    "silent_audio_before_call_ms": 2280,
    "loud_audio_before_call_ms": 2330,
    "args": {
     "item_id": "burger",
     "quantity": 3
    },
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 5.655899999983376,
    "silence_total_ms": 4617.487999999983
   }
  ],
  "corrections": [
   {
    "label": "correction:late_1500",
    "t_marker_ms": 8565.340100000001,
    "vad_lag_ms": 1414.77919999999,
    "final_lag_ms": null,
    "call_arrived_after_correction_began": true,
    "blind": false,
    "call_id": "chatcmpl-tool-9fe75a4d6b1f4552"
   }
  ],
  "barge": []
 },
 {
  "scenario": "late_correction_1500ms",
  "calls": [
   {
    "call_id": "chatcmpl-tool-875e2ddd8f32fb14",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 10355.720700000005,
    "hold_ms": 0.6619000000064261,
    "final_before_call": false,
    "stopped_to_call_ms": 1916.5909999999858,
    "spoke_before_call": false,
    "silent_audio_before_call_ms": 1930,
    "loud_audio_before_call_ms": 0,
    "args": {
     "item_id": "burger",
     "modifiers": [],
     "quantity": 2
    },
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 12.390299999999115,
    "silence_total_ms": 1929.6431999999913
   },
   {
    "call_id": "chatcmpl-tool-b19a3a9e2f6bc4c6",
    "tool": "update_quantity",
    "mutating": true,
    "t_call_ms": 18978.68360000002,
    "hold_ms": 0.11299999998300336,
    "final_before_call": false,
    "stopped_to_call_ms": 4667.9859,
    "spoke_before_call": true,
    "silent_audio_before_call_ms": 2230,
    "loud_audio_before_call_ms": 2440,
    "args": {
     "item_id": "burger",
     "quantity": 3
    },
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 4.043800000014016,
    "silence_total_ms": 4672.142699999997
   }
  ],
  "corrections": [
   {
    "label": "correction:late_1500",
    "t_marker_ms": 8735.998900000006,
    "vad_lag_ms": 1401.386200000008,
    "final_lag_ms": null,
    "call_arrived_after_correction_began": true,
    "blind": false,
    "call_id": "chatcmpl-tool-875e2ddd8f32fb14"
   }
  ],
  "barge": []
 },
 {
  "scenario": "late_correction_400ms",
  "calls": [
   {
    "call_id": "chatcmpl-tool-bc2c1d7f9da3517a",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 15793.919500000004,
    "hold_ms": 0.4624000000039814,
    "final_before_call": true,
    "stopped_to_call_ms": 2671.9358999999968,
    "spoke_before_call": false,
    "silent_audio_before_call_ms": 2680,
    "loud_audio_before_call_ms": 0,
    "args": {
     "item_id": "burger",
     "modifiers": [],
     "quantity": 3
    },
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 10.995999999999185,
    "silence_total_ms": 2683.3943
   }
  ],
  "corrections": [
   {
    "label": "correction:late_400",
    "t_marker_ms": 7582.306500000006,
    "vad_lag_ms": 1756.2831000000006,
    "final_lag_ms": 757.7373999999982,
    "call_arrived_after_correction_began": true,
    "blind": false,
    "call_id": "chatcmpl-tool-bc2c1d7f9da3517a"
   }
  ],
  "barge": []
 },
 {
  "scenario": "late_correction_400ms",
  "calls": [
   {
    "call_id": "chatcmpl-tool-a2f5c05b76c5e200",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 10773.198600000003,
    "hold_ms": 0.5846000000019558,
    "final_before_call": false,
    "stopped_to_call_ms": 1835.3962000000029,
    "spoke_before_call": false,
    "silent_audio_before_call_ms": 1750,
    "loud_audio_before_call_ms": 0,
    "args": {
     "item_id": "burger",
     "modifiers": [],
     "quantity": 2
    },
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 2949.4832000000024,
    "silence_total_ms": 4785.464000000007
   }
  ],
  "corrections": [
   {
    "label": "correction:late_400",
    "t_marker_ms": 7923.367400000003,
    "vad_lag_ms": 1934.138300000006,
    "final_lag_ms": 1014.7356,
    "call_arrived_after_correction_began": true,
    "blind": false,
    "call_id": "chatcmpl-tool-a2f5c05b76c5e200"
   }
  ],
  "barge": []
 },
 {
  "scenario": "late_correction_900ms",
  "calls": [
   {
    "call_id": "chatcmpl-tool-91900d11759cad14",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 10606.4225,
    "hold_ms": 0.7575999999826308,
    "final_before_call": false,
    "stopped_to_call_ms": 1960.0659999999916,
    "spoke_before_call": false,
    "silent_audio_before_call_ms": 1860,
    "loud_audio_before_call_ms": 0,
    "args": {
     "item_id": "burger",
     "modifiers": [],
     "quantity": 2
    },
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 3330.2715000000026,
    "silence_total_ms": 5291.095099999977
   }
  ],
  "corrections": [
   {
    "label": "correction:late_900",
    "t_marker_ms": 8281.834499999997,
    "vad_lag_ms": 1466.050000000003,
    "final_lag_ms": 364.6198000000004,
    "call_arrived_after_correction_began": true,
    "blind": false,
    "call_id": "chatcmpl-tool-91900d11759cad14"
   }
  ],
  "barge": []
 },
 {
  "scenario": "late_correction_900ms",
  "calls": [
   {
    "call_id": "chatcmpl-tool-99b014cba0160646",
    "tool": "add_item",
    "mutating": true,
    "t_call_ms": 10178.580300000001,
    "hold_ms": 0.9326000000000931,
    "final_before_call": false,
    "stopped_to_call_ms": 2076.2639999999956,
    "spoke_before_call": false,
    "silent_audio_before_call_ms": 1870,
    "loud_audio_before_call_ms": 0,
    "args": {
     "item_id": "burger",
     "modifiers": [],
     "quantity": 2
    },
    "speech_started_during_hold": 0,
    "finals_during_hold": [],
    "finals_after_result": [],
    "pause_after_result_ms": 3213.7262000000046,
    "silence_total_ms": 5290.9228
   }
  ],
  "corrections": [
   {
    "label": "correction:late_900",
    "t_marker_ms": 7948.590800000005,
    "vad_lag_ms": 1250.2249999999767,
    "final_lag_ms": 150.8177999999898,
    "call_arrived_after_correction_began": true,
    "blind": false,
    "call_id": "chatcmpl-tool-99b014cba0160646"
   }
  ],
  "barge": []
 }
]
```