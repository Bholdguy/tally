# Local speech-activity check: direct measurement (fixtures/aai-events-A-hold)
Generated 2026-09-20T12:10:48.149Z by scripts/measure-local-vad.ts. Production LocalVad (defaults) run over the exact PCM streamed in 21 spike-A sessions.
**Synthetic SAPI speech + digital silence between clips: this measures the algorithm on clean audio. It says nothing about microphone noise (see TESTING.md §11).**

## Onset detection lag
- algorithmic lag (speech began -> flag raised), media time: p50 40 ms, max 40 ms  (n=36 onsets)
- same measured on the wall clock of the real streaming schedule: p50 42 ms, p95 49 ms, max 50 ms

## Lead over the other speech signals (positive = local check flagged EARLIER)
- vs independent stream SpeechStarted: p50 476 ms, min 353 ms, max 635 ms  (n=36)
- vs Voice Agent input.speech.started: p50 1382 ms, min 1182 ms, max 2094 ms  (n=33)

## End of speech vs the independent final
- local speech_end detected -> independent final arrives: p50 1369 ms, max 1544 ms  (n=36); this is the wait the gate imposes after speech ends

## Coverage at each tool.call (late / during-hold / silent-reply barge runs)
- runs where the agent's FIRST call carried the stale quantity: 11
- customer speech **unresolved at the instant of the call** (the gate's own trigger to wait: speaking now, or ended with no independent final yet): **8 of 11**
  - of those, the local check was actively flagging speech ("speaking now") at the call in 6; in the other 2 the customer had just finished (speech_end already detected) but the independent final had not yet arrived
- NOT unresolved at the call: correction_during_hold-1, correction_during_hold-2, correction_during_hold-3
  - the correction began AFTER the call (local check flagged it 145 ms after / 188 ms after / 199 ms after the call). At decision time nobody was speaking, so the gate has nothing to wait on. This is an inherent limit of judging at call time; it is closed by the next call's validation and by the confirm-time reconciliation (D-22).
- non-stale runs (the call already carried the corrected quantity): unresolved at call 0 of 4 (the correction had long finished)

## False triggers (speech flagged where no clip was playing)
- 0 across 21 sessions (digital silence: not informative about real rooms)

## Per-run detail

| run | onsets | lag media/wall (ms) | lead over stt SS (ms) | lead over agent SS (ms) | end→final (ms) | speaking at call | unresolved at call | stale call |
|---|---|---|---|---|---|---|---|---|
| barge_in-1 | 2 | 40/40 / 31/44 | 452, 412 | 1399, 1536 | 1360, 451 | true | true | true |
| barge_in-2 | 2 | 40/40 / 32/44 | 469, 412 | 1258, 1700 | 1389, 417 | true | true | true |
| barge_in-3 | 2 | 40/40 / 31/43 | 466, 580 | 1798, 2094 | 1369, 655 | true | true | true |
| clean_order-1 | 1 | 40 / 33 | 353 | 1478 | 1387 | false | false | true |
| clean_order-2 | 1 | 40 / 42 | 366 | 1382 | 1402 | false | false | true |
| clean_order-3 | 1 | 40 / 31 | 473 | 1243 | 1379 | false | false | true |
| correction_during_hold-1 | 2 | 40/40 / 48/33 | 487, 546 | 1342 | 354, 1461 | false | false | true |
| correction_during_hold-2 | 2 | 40/40 / 26/43 | 474, 473 | 1214 | 475, 1368 | false | false | true |
| correction_during_hold-3 | 2 | 40/40 / 31/49 | 635, 634 | 1451 | 354, 1404 | false | false | true |
| inline_correction-1 | 1 | 40 / 31 | 510 | 1395 | 1462 | false | false | false |
| inline_correction-2 | 1 | 40 / 47 | 538 | 1585 | 1486 | false | false | false |
| inline_correction-3 | 1 | 40 / 44 | 604 | 1364 | 1544 | false | false | false |
| late_correction_1500ms-1 | 2 | 40/40 / 32/44 | 567, 476 | 1397, 1337 | 469, 1414 | true | true | true |
| late_correction_1500ms-2 | 2 | 40/40 / 32/42 | 527, 463 | 1513, 1437 | 371, 1400 | true | true | true |
| late_correction_1500ms-3 | 2 | 40/40 / 50/38 | 526, 438 | 1300, 1232 | 464, 1414 | true | true | true |
| late_correction_400ms-1 | 2 | 40/40 / 32/46 | 507, 527 | 1360, 1548 | 454, 1401 | false | false | false |
| late_correction_400ms-2 | 2 | 40/40 / 30/47 | 501, 444 | 1524, 1846 | 560, 1406 | false | false | false |
| late_correction_400ms-3 | 2 | 40/40 / 49/42 | 492, 419 | 1314, 1746 | 488, 1382 | false | false | false |
| late_correction_900ms-1 | 2 | 40/40 / 31/45 | 617, 444 | 1273, 1182 | 529, 1417 | false | true | true |
| late_correction_900ms-2 | 2 | 40/40 / 41/47 | 609, 412 | 1342, 1335 | 465, 1414 | false | true | true |
| late_correction_900ms-3 | 2 | 40/40 / 34/42 | 603, 429 | 1302, 1218 | 467, 1393 | false | false | false |
