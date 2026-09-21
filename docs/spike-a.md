# Spike A: independent STT stream as correction evidence (blocking before Step 5)

**RUN 2026-09-20 against the real AssemblyAI APIs. VERDICT: PASS. The independent stream closes the evidence gap in this sample.**
Owner's condition (D-04, D-19): *confirm the independent STT stream keeps delivering transcripts in real time while the primary Voice Agent session is in a hold, on the scenarios that failed in spike-g5.* It does (§2). **Step 5 has not been started; it awaits your review.**

## 1. What was run
- **Spike A (primary, hold mode, as designed):** 21 live sessions, 3 repeats × 7 scenarios (`clean_order`, `inline_correction`, `late_correction_{400,900,1500}ms`, `correction_during_hold`, `barge_in`). Each session ran **two connections on the same PCM chunks**: the Voice Agent session (mutating tools `execution_mode:"hold"`) and Tally's independent STT stream (`wss://streaming.assemblyai.com/v3/ws`, `speech_model=universal-3-5-pro`, 24 kHz PCM16, 50 ms binary frames, key in the `Authorization` header). Both share one clock. Evidence: `fixtures/aai-events-A-hold/*.jsonl` (+ `.stt.jsonl`, `.timeline.json`).
- **Spike B (diagnostic only, per D-19):** 12 sessions, same scenarios minus clean, mutating tools forced to `interactive` (server echoed `interactive`; verified). Evidence: `fixtures/aai-events-B-interactive/`. **B's approach is NOT a gating design candidate.**
- **Option C (safety net) on real data:** stored timelines fetched for all 33 sessions and reconciled (§5).
- Stub tool handler (no validation), synthetic Windows-SAPI speech, client-observed timings. Same limits as spike-g5 (N small, clean audio, single speaker).

## 2. Spike A results: the independent stream in hold mode

18 correction runs (clean excluded). Times in ms, client-observed on the shared clock. "vs call" = relative to the agent's first `add_item` `tool.call`.

| Scenario (N=3) | Correction on the **Voice Agent live stream** | Correction on the **independent stream** (any / final with "wait"+3) | First partial vs call (p50 / max) | Final vs call (p50 / max) | Final lag after speech end (max) | Independent turns received *during* the hold |
|---|---|---|---|---|---|---|
| `inline_correction` | 3/3 | 3/3 · 3/3 | already in hand (−6.3 s) | already in hand | 1172 | 0 (call came later) |
| `late_correction_400ms` | 3/3 | 3/3 · 3/3 | already in hand | already in hand | 991 | 0 (call came later) |
| `late_correction_900ms` | **1/3** | **3/3 · 3/3** | 103 / 499 | 1154 / 1381 | 1002 | 0 |
| `late_correction_1500ms` | **0/3** | **3/3 · 3/3** | 688 / 700 | 1638 / 1825 | 997 | 0 |
| `correction_during_hold` (2.5 s hold) | **0/3** | **3/3 · 3/3** | 2366 / 2430 | 3453 / **3470** | 1038 | **10** (4 + 3 + 3) |
| `barge_in` (user over a silent reply) | **0/3** | **3/3 · 3/3** | 1282 / 2049 | 2124 / 2355 | 242 | 0 (fired after our result) |
| **Total** | **7/18 (39%)** | **18/18 (100%) · 18/18** | | | | |

### Answer to the blocking question
| Question | Finding |
|---|---|
| Does the independent stream keep delivering transcripts in real time while the primary session is in a hold? | **Yes.** In `correction_during_hold` it delivered 4, 3 and 3 turn updates *inside* the hold window (tool.call → our tool.result). The Voice Agent stream delivered **0** speech events and **0** transcripts in the same window (3/3 runs). |
| Did it deliver the correction where the live stream never did? | **Yes: 11/11** stale-first-call cases, plus all 7 that the live stream also had. |
| Is it text-correct? | 18/18 finals contained "3" and the correction cue ("No, wait, make it 3."). |
| Does it emit its own speech-activity signal? | **Yes: `SpeechStarted {timestamp, confidence}`**, in 15/15 late/hold/barge runs, including 3/3 during hold (the agent's `input.speech.started` fired 0/3 there). Lag from audio start: **0.52–0.75 s**, versus the agent's 1.29–2.20 s. |
| Did any stream drop? | 0/21 (21 `Begin`, 21 `Termination`). |
| Does the normal (uncorrected) path pay a latency cost? | **No.** The independent stream's first final for the first utterance arrived **before the agent's first `tool.call` in 21/21 runs**, so the gate never waits when nobody is speaking. |
| Real confidence available? | **Yes: per-word `confidence` on every Turn.** Min word confidence on the correction finals: 0.67–0.89 (inline 0.67). This corrects D-03: the live Voice Agent stream has none, the independent stream does. |

### How long would the gate have to wait? (feeds Step 5 sizing)
- Wait for the independent stream's **final** after `tool.call`, across the 11 runs where the agent's call was stale: **1.15 s – 3.47 s** (worst case = correction started at the same instant as the call, in the 2.5 s-hold scenario). Others ≤ 2.36 s.
- **Recommended `EVIDENCE_WAIT_MAX_MS = 4000`** (measured max 3470 ms + ~15%); expiry ⇒ `HOLD PENDING_EVIDENCE` (fail closed). Configurable; to be re-measured in Step 12 with real metrics.
- **Speech-in-flight detection.** In all 11 stale-call runs the correction audio was still being sent when `tool.call` arrived (computed from send markers, `scripts/spike-a-vad-coverage.mjs`). So a zero-lag **local energy VAD on Tally's own input PCM** would have flagged every one. The independent `SpeechStarted` (lag ≈ 0.55 s) covered 8 of the 11 before the call, with a margin as thin as **101 ms** in one run; the other 3 (`correction_during_hold`) began *after* the call by design. Conclusion: use **both** (local VAD for zero-lag, `SpeechStarted` as the independent second signal). *The local-VAD claim is inferred from send timing on synthetic audio and must be validated on real energy in Step 4; it is not yet measured.*

## 3. Outcomes: what the agent alone did (the failure Tally must prevent)
Same computation on both modes (`scripts/spike-outcomes.mjs`), correction runs only:

| | First `tool.call` carried the stale quantity 2 | Order ended at 3 | Agent said the stale "two" aloud |
|---|---|---|---|
| **A: hold mode** (N=18) | **11 / 18** | 12 / 18 (**6 stale at the end**) | 3 / 18 |
| **B: interactive, diagnostic** (N=12) | **9 / 12** | **12 / 12** | 0 / 12 |

The premature first call happens in **both** modes; it is model behaviour, not a protocol artifact. What differs is whether the correction is visible afterwards.

## 4. Spike B: is the evidence gap specific to hold mode?
**Yes, in this sample.** In interactive mode the correction reached the live stream in **12/12** (hold: 7/18), including `correction_during_hold` (2/2) and `barge_in` (2/2); the agent then repaired itself every time. In interactive mode we send `tool.result` only after `reply.done` (the docs' rule; observed), and the correction's transcript streamed *while that first result was still pending*.
Also observed: **no audible agent speech before the first `tool.call` in interactive mode either** (12/12 silent padding), so the feared "agent speaks before validation" did not appear in this sample. This is a small, prompt-dependent sample and the docs say interactive mode adds a spoken transition, so I am **not** treating it as a design signal. Per your instruction B stays a diagnostic: D-01 (hold for mutating tools) is unchanged, and I have not touched the gating design because of it. If you ever want interactive mode reconsidered, that would be a separate decision with its own evidence.

## 5. Option C (safety net) on real captures
`reliability/src/reconcile.ts` (pure) + `stt/src/timeline.ts` (read-only fetch), run on all real sessions:
- **Spike A (33-session set reconciled: 21 A + 12 B):** in A it flags **exactly the 11 stale-first-call sessions** as `LIVE_TRANSCRIPT_MISSING` and nothing else; in B **0 findings** (live stream was complete). Independent-stream findings: 0.
- The first version produced **6 false positives** on real data (the stored timeline merged two utterances that the streams delivered as two turns). Fixed (match against the concatenated pool too) and pinned by `reliability/test/reconcile-real.test.ts` on real fixtures.
- **`user_confidence` is constant 1.0 in all 53 stored turns** (A+B). The field exists and is wired to `LOW_TIMELINE_CONFIDENCE`, but in this sample it carries **no information**, so it cannot currently serve as a quality signal. The independent stream's per-word confidence can. Recommendation: treat stored `user_confidence` as an optional cross-check only, and base confidence-driven holds on the independent stream's word confidences.

## 6. Verdict
**Spike A: PASS.** The independent stream (a) keeps delivering during hold, (b) delivered 18/18 corrections including all 11 the live stream lost, (c) adds no latency on the uncorrected path, (d) supplies real word confidence and its own speech signal. **Recommend proceeding to Step 5 with the evidence design below, once you approve.**

Step 5 evidence design implied by this spike (not started):
1. Gate judges tool calls against the **independent stream's** transcripts (extractor input = `evidence_transcript` events), never the agent's.
2. If local VAD or the independent `SpeechStarted`/un-finalised partial says the customer is speaking (or spoke within a short hangover), hold the tool result until the independent stream finalises that turn, up to `EVIDENCE_WAIT_MAX_MS=4000`; on expiry `HOLD PENDING_EVIDENCE`.
3. If the independent stream is down or silent when speech is expected, fail closed (`UNVALIDATABLE`).
4. Words below a confidence threshold inside entity spans (quantity/item) ⇒ `HOLD` (uses per-word confidence; threshold tuned in Step 12).
5. Option C runs after every call as the permanent safety net.

## 7. Limits and risks (stated up front)
- **N = 3 per scenario (A) / 2 (B), 33 sessions**; synthetic SAPI speech; clean audio; one speaker; no noise or crosstalk. "18/18" is a feasibility result, not an accuracy rate. Real-world accuracy of the independent stream (accents, noise) is **unproven**; min word confidence 0.63–0.67 on clean synthetic speech already shows headroom is not unlimited.
- The two connections are separate services: a real failure of the independent stream must be handled fail-closed (design point 3); **not exercised in this spike** (0/21 drops).
- Concurrency: 2 streaming connections per call; the streaming API's default limit for free accounts is 5 concurrent, so about 5 concurrent calls (or 2 if the Voice Agent shares the pool: unverified).
- Cost: about +$0.45/h on top of the $4.50/h Voice Agent rate.
- Local-VAD coverage (11/11) is inferred from send timing, not measured on energy.
- Timings are client-observed; both streams share one client clock, so cross-stream comparisons are consistent, but absolute network latency is included.
- The synthetic clips have some lead-in silence, so lags measured from clip start are upper bounds.

## 8. CORRECTIONS added 2026-09-20 during Step 4/5 (measured after this report was written)
These supersede statements above; the originals are left in place so the change is visible.
1. **§2 "How long would the gate have to wait?" claimed a local VAD "would have flagged every one" of the 11 stale-call runs because the correction audio "was still being sent when `tool.call` arrived".** That was an inference from clip timing, and it was **wrong**. Measured directly on the exact PCM that was streamed (`docs/local-vad-measurement.md`) and confirmed by replaying the real captures through the real tracker/gate: customer speech was **unresolved at the call in 8 of 11** (6 speaking, 2 just finished with no independent final yet). In the **other 3** (`correction_during_hold`) the correction began **145–199 ms after** the call. The 3 are handled by the next call's validation and by the confirm-time reconciliation (DECISIONS D-22), not by waiting.
2. **§3 "Order ended at 3" (A: 12/18) counted quantity only.** Replaying the agent's real calls exposed hallucinated modifiers in runs I had counted as correct: `late_correction_400ms-2` sent `add_item(burger ×3, [no_onions, no_pickles, no_tomato, no_lettuce, no_sauce])` for "No, wait, make it 3"; `clean_order-2` sent `add_item(coke, [size_large])`. Treat 12/18 as an upper bound. The gate holds both.
3. **Measured gate behaviour on these 21 real captures** (deterministic replay, `reliability/test/gate-replay-real.test.ts`): 8/8 stale-and-unresolved calls held `QTY_MISMATCH(3)` after a **1175–2375 ms** wait (median 1650); 6 already-correct calls allowed; 3 clean orders allowed with 0 ms wait; 3 corrections-after-the-call allowed (inherent); 2 real hallucinations held.
4. **New in this work:** dropout of the independent stream fails closed, verified against the real API (`docs/step5-live-dropout.json`): severed mid-wait -> HOLD `UNVALIDATABLE` 38 ms later, order unchanged.
5. Still true and still limiting: synthetic speech, n=3 per scenario, single speaker. The required real-speech pass (TESTING.md §11, DECISIONS D-21) has **not** been run.
