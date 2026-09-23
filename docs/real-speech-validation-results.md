# Real-speech validation results (data/real-speech)
Generated 2026-09-23T17:44:43.259Z; 36 recordings. **OVERALL: FAIL**
Criteria were fixed before any run: {"minSpeakers":3,"minRecordingsPerSpeaker":10,"minNoiseRecordings":3,"maxConfirmedWrongOrders":0,"maxFalseHoldRate":0.15,"minEvidenceAccuracyClean":0.95,"maxEvidenceWaitMs":4000,"maxStallRateClean":0.05}

| id | criterion | result | detail |
|---|---|---|---|
| P1 | 0 confirmed orders that differ from the speaker's intent | **PASS** | 0 confirmed wrong: none |
| P3 | false-hold rate on valid calls <= 15% overall | **FAIL** | 13/56 = 23.2% |
| P3b | false-hold rate on valid confirm_order calls <= 15% (D-22 trade-off, reported separately) | **FAIL** | 1/3 = 33.3% |
| P4 | independent-stream evidence reproduces the intent in >= 95% of clean-room recordings | **FAIL** | 24/30 = 80.0% |
| P5 | every evidence wait <= 4000 ms | **FAIL** | max 4508 ms; PENDING_EVIDENCE holds: 3 |
| P6 | local-speech stalls in <= 5% of clean-room recordings | **PASS** | 1/30 |
| P7 | coverage: >= 3 speakers x >= 10 recordings each, each with an imperfect AND an overlapping correction, plus >= 3 noisy recordings | **PASS** | 3 speakers; recordings per speaker: Ayoola=12, Ola=12, Tunde=12; noisy 6 |

## Recordings

| recording | speaker | kind | noise | order = intent | status | evidence ok | calls (verdict/code) | stalls |
|---|---|---|---|---|---|---|---|---|
| Ayoola-01 | Ayoola | clean |  | yes | open | yes | add_item:ALLOW, add_item:ALLOW | 0 |
| Ayoola-02 | Ayoola | clean |  | NO | open | yes |  | 0 |
| Ayoola-03 | Ayoola | inline_correction |  | yes | confirmed | yes | add_item:ALLOW, add_item:ALLOW, confirm_order:ALLOW | 0 |
| Ayoola-04 | Ayoola | late_correction |  | NO | open | NO | add_item:HOLD/QTY_MISMATCH, add_item:HOLD/MODIFIER_MISMATCH* | 0 |
| Ayoola-05 | Ayoola | imperfect_correction |  | NO | open | yes | add_item:HOLD/UNVALIDATABLE, add_item:ALLOW | 0 |
| Ayoola-06 | Ayoola | imperfect_correction |  | NO | open | yes | add_item:HOLD/ITEM_MISMATCH*, add_item:ALLOW | 0 |
| Ayoola-07 | Ayoola | overlapping_correction |  | yes | open | yes | add_item:ALLOW, add_item:ALLOW | 0 |
| Ayoola-08 | Ayoola | late_correction |  | NO | open | NO | add_item:HOLD/PENDING_EVIDENCE | 0 |
| Ayoola-09 | Ayoola | clean |  | yes | open | yes | add_item:ALLOW, add_item:HOLD/UNSUPPORTED_CLAIM* | 0 |
| Ayoola-10 | Ayoola | backchannel |  | yes | open | yes | add_item:ALLOW, add_item:ALLOW, add_item:HOLD/UNVALIDATABLE | 1 |
| Ayoola-11 | Ayoola | noise | tv | yes | open | yes | add_item:ALLOW, add_item:ALLOW | 0 |
| Ayoola-12 | Ayoola | noise | fan | NO | open | NO | add_item:HOLD/ITEM_MISMATCH, add_item:HOLD/QTY_MISMATCH | 0 |
| Ola-01 | Ola | clean |  | NO | open | NO | add_item:HOLD/UNSUPPORTED_CLAIM, add_item:HOLD/UNSUPPORTED_CLAIM | 0 |
| Ola-02 | Ola | clean |  | NO | open | yes |  | 0 |
| Ola-03 | Ola | inline_correction |  | yes | open | yes | add_item:ALLOW, add_item:ALLOW | 0 |
| Ola-04 | Ola | late_correction |  | NO | open | NO | add_item:ALLOW*, update_quantity:HOLD/QTY_MISMATCH, add_item:HOLD/MODIFIER_MISMATCH* | 0 |
| Ola-05 | Ola | imperfect_correction |  | yes | open | yes | add_item:ALLOW, add_item:ALLOW | 0 |
| Ola-06 | Ola | imperfect_correction |  | yes | open | yes | add_item:ALLOW, add_item:ALLOW | 0 |
| Ola-07 | Ola | overlapping_correction |  | yes | open | yes | add_item:ALLOW, add_item:ALLOW | 0 |
| Ola-08 | Ola | late_correction |  | yes | open | NO | add_item:ALLOW | 0 |
| Ola-09 | Ola | clean |  | yes | open | yes | add_item:ALLOW, add_item:HOLD/UNSUPPORTED_CLAIM* | 0 |
| Ola-10 | Ola | backchannel |  | yes | open | yes | add_item:ALLOW, add_item:ALLOW | 0 |
| Ola-11 | Ola | noise | tv | NO | open | yes | add_item:HOLD/UNVALIDATABLE, add_item:ALLOW, confirm_order:HOLD/UNVALIDATABLE* | 0 |
| Ola-12 | Ola | noise | fan | yes | open | yes | add_item:ALLOW, add_item:ALLOW | 0 |
| Tunde-01 | Tunde | clean |  | yes | open | yes | add_item:ALLOW, add_item:ALLOW | 0 |
| Tunde-02 | Tunde | clean |  | NO | open | yes |  | 0 |
| Tunde-03 | Tunde | inline_correction |  | yes | confirmed | yes | add_item:ALLOW, add_item:ALLOW, confirm_order:ALLOW, confirm_order:HOLD/SCHEMA_INVALID | 0 |
| Tunde-04 | Tunde | late_correction |  | NO | open | yes | add_item:HOLD/PENDING_EVIDENCE* | 0 |
| Tunde-05 | Tunde | imperfect_correction |  | NO | open | yes |  | 0 |
| Tunde-06 | Tunde | imperfect_correction |  | NO | open | yes | add_item:HOLD/UNVALIDATABLE, add_item:ALLOW | 0 |
| Tunde-07 | Tunde | overlapping_correction |  | yes | open | yes | add_item:ALLOW, add_item:ALLOW | 0 |
| Tunde-08 | Tunde | late_correction |  | NO | open | NO |  | 0 |
| Tunde-09 | Tunde | clean |  | NO | open | yes | add_item:HOLD/PENDING_EVIDENCE | 0 |
| Tunde-10 | Tunde | backchannel |  | yes | open | yes | add_item:ALLOW, add_item:ALLOW | 0 |
| Tunde-11 | Tunde | noise | tv | yes | open | yes | add_item:ALLOW, add_item:ALLOW | 0 |
| Tunde-12 | Tunde | noise | fan | yes | open | yes | add_item:ALLOW, add_item:ALLOW | 0 |

`*` = the call content did not match the speaker's intent (a hold there is a true positive).

## Misses, with the independent-stream transcript (every miss must be explained)
- **Ayoola-02** order diff: {"equal":false,"missing":["burger","fries"],"extra":[],"wrong":[]}; transcripts: ["A burger with no onions and extra cheese and fries with no salt. Pickup at 6:30."]
- **Ayoola-04** order diff: {"equal":false,"missing":["burger","coke"],"extra":[],"wrong":[]}; transcripts: ["2 burgers.","No, wait.","his tea and a Coke. That's all. As soon as possible."]
- **Ayoola-05** order diff: {"equal":false,"missing":["burger"],"extra":[],"wrong":[]}; transcripts: ["Tsubo.","Oh no, I mean three burgers, um, and a Diet Coke, thats all, as soon as possible."]
- **Ayoola-06** order diff: {"equal":false,"missing":["burger"],"extra":[],"wrong":[]}; transcripts: ["Make it whole to— no.","3, 3 burgers and fries as soon as possible."]
- **Ayoola-08** order diff: {"equal":false,"missing":["veggie_burger"],"extra":[],"wrong":[]}; transcripts: ["A cheeseburger, actually.","A veggie burger, that's all, as soon as possible."]
- **Ayoola-12** order diff: {"equal":false,"missing":["burger","coke"],"extra":[],"wrong":[]}; transcripts: ["2 workers.","No, wait, make it 3 and a large Coke. That's all. As soon as possible."]
- **Ola-01** order diff: {"equal":false,"missing":["burger","coke"],"extra":[],"wrong":[]}; transcripts: ["Tsubogazana call Kudatsal pick up as soon as possible."]
- **Ola-02** order diff: {"equal":false,"missing":["burger","fries"],"extra":[],"wrong":[]}; transcripts: ["A burger with no onion and extra cheese and fries with no salt. Pick up at 6:30."]
- **Ola-04** order diff: {"equal":false,"missing":["coke"],"extra":[],"wrong":["burger: committed {\"item_id\":\"burger\",\"quantity\":2,\"modifiers\":[]} vs intended {\"item_id\":\"burger\",\"quantity\":3,\"modifiers\":[]}"]}; transcripts: ["2 burgers.","No, wait, make history.","And a Coke, that's all, as soon as possible."]
- **Ola-08** order diff: {"equal":true,"missing":[],"extra":[],"wrong":[]}; transcripts: ["A cheeseburger, actually a veggie burger, does so as soon as possible."]
- **Ola-11** order diff: {"equal":false,"missing":["burger"],"extra":[],"wrong":[]}; transcripts: ["Two burgers and a Coke, that's all.","Pick up as soon as possible."]
- **Tunde-02** order diff: {"equal":false,"missing":["burger","fries"],"extra":[],"wrong":[]}; transcripts: ["A burger with no onions and extra cheese.","And fries with no salt. Pickup at 6:30."]
- **Tunde-04** order diff: {"equal":false,"missing":["burger","coke"],"extra":[],"wrong":[]}; transcripts: ["2 burgers. No, wait, make it 3. And a Coke. That's all.","as soon as possible."]
- **Tunde-05** order diff: {"equal":false,"missing":["burger","diet_coke"],"extra":[],"wrong":[]}; transcripts: ["2 bo— oh no, I mean 3 burgers, um, and a Diet Coke. That's all. As soon as possible."]
- **Tunde-06** order diff: {"equal":false,"missing":["burger"],"extra":[],"wrong":[]}; transcripts: ["Make it hole 2 no.","3 burgers and fries as soon as possible."]
- **Tunde-08** order diff: {"equal":false,"missing":["veggie_burger"],"extra":[],"wrong":[]}; transcripts: []
- **Tunde-09** order diff: {"equal":false,"missing":["burger"],"extra":[],"wrong":[]}; transcripts: ["Two burgers and fries cancel the fries as soon as possible."]
