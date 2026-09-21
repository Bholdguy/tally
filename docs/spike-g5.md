# Spike G5: hold-mode gating go/no-go (Step 3 blocking gate)

**STATUS: RUN against the real AssemblyAI Voice Agent API on 2026-09-19.**
**VERDICT: NO-GO for hold-mode gating as designed. Step 5 stays BLOCKED pending an owner decision (see §6).**

Owner's criterion: *corrections consistently arriving before or during `tool.result` ⇒ go; corrections routinely arriving after `tool.result` has fired ⇒ no-go, add a buffer window.* Observed: in 7 of 8 late-correction / during-hold runs the correction's transcript **never reached the live event stream at all**, before or after `tool.result`. That is worse than "late", and it means a buffer window alone cannot fix it (§5).

## 1. What was run
- 36 live sessions in total against `wss://agents.assemblyai.com/v1/ws`, Bearer auth, config v1 (system prompt, six tools, mutating tools `execution_mode:"hold"`, `transcription_mode:"max_accuracy"`, menu keyterms). The server accepted the config (`session.updated`; the stored session config shows `execution_mode: hold` on all five mutating tools).
- Input: synthetic speech (Windows SAPI, 24 kHz PCM16) streamed at real time. Stub tool handler (`agent/src/spike/stub-handler.ts`: pass-through, no validation) returning results immediately (2.5 s artificial delay in `correction_during_hold`).
- Of these, **20 are valid evidence** (`fixtures/aai-events/*.jsonl`: 16 from run 2 + 4 real-speech interruption runs) and 16 are the archived contaminated run 1. Raw logging: Every wire message is logged with client-stamped `t_ms`; audio payloads are replaced by byte count and RMS energy.
- Independent cross-checks against AssemblyAI's own artifacts for the same sessions: `GET /v1/sessions/{id}` timelines (what the server recorded), and a transcription of the stereo recording of `clean_order-1`.

### Disclosures: what went wrong in the spike itself
1. **Run 1 was contaminated and is archived, not used for the verdict** (`fixtures/aai-events/run1-greeting-collision/`). My scenarios started 170 ms after connect and talked over the greeting in every run; the log also stripped audio, so silence padding could not be told from speech, and the analyzer wrongly reported "agent spoke before 26/26 tool calls". Run 1 showed the same qualitative correction pattern (correction transcript streamed in 1 of 8 late/hold runs), which is why run 2 was worth doing, but no number below comes from run 1.
2. **Run 2 fixed both** (waits for the greeting `reply.done`; records per-chunk RMS).
3. **Two scenarios did not test what they were named for and were replaced.** `barge_in` and `backchannel` played their clip while the agent was only streaming hold-mode silence, so nothing was actually interrupted. Their data is kept in `run2-silent-barge/` and reported as "user speech over a silent reply". `barge_in_speech` / `backchannel_speech` wait for audible agent speech and are the valid tests.
4. **The analyzer's machine verdict said FAIL on H1 (3/33 calls "spoke before tool.call"). I checked those three by hand:** all three are `update_quantity(3)` self-corrections issued *after* the agent had already said the stale quantity aloud in reply to the earlier tool result. That is a real finding (§3) but not a hold-mode violation on the first call.

## 2. Verdict table: all scenarios (N = 2 each; times client-observed, ms)

| # | Scenario | What the customer said | What the API delivered (event ordering) | Quantity in first `tool.call` | Correction transcript reached us? | Order at end of run |
|---|---|---|---|---|---|---|
| 1 | `clean_order` | "two burgers and a coke" | `transcript.user` final → `reply.started` + **silence** frames (~1.5 s) → `tool.call` (≈1.5 s after speech end in run 1) → our `tool.result` → next reply → next `tool.call`. Agent spoke only after the last result. | 2 ✔ | n/a | correct; a 3rd call, a duplicate `add_item(coke)` (`ALREADY_IN_ORDER`), was issued in 2/2 |
| 2 | `inline_correction` | "two burgers, no wait, make it three" (one utterance) | deltas grow "2" → "2 burgers," → "…no wait, make it" → "…3." ; final `transcript.user` "2 burgers. No, wait, make it 3." **before** `tool.call` | **3 ✔** (2/2) | **yes** (2/2, before `tool.call`) | correct |
| 3 | `late_correction_400ms` | "two burgers" … 0.4 s … "no wait, make it three" | run 1: model **waited** for the correction; final `transcript.user` "No, wait, make it 3." arrived before `tool.call`. run 2: `tool.call` fired with 2; `input.speech.started` for the correction fired 916 ms earlier; transcript never streamed | 3 ✔ / **2 ✘** | 1/2 | 1 correct, **1 stale (2)** |
| 4 | `late_correction_900ms` | same, 0.9 s gap | `input.speech.started` (correction) fired 859 / 980 ms **before** `tool.call`; `tool.call` qty 2; **no** `transcript.user` for the correction, ever; `input.speech.stopped` only 3.3 s after the call. Agent then said "Okay, two burgers." | **2 ✘** (2/2) | **0/2** | **stale (2) 2/2** |
| 5 | `late_correction_1500ms` | same, 1.5 s gap | `input.speech.started` fired only 115 / 218 ms before `tool.call`; qty 2; **no** correction transcript; agent said the stale quantity aloud, then self-corrected with `update_quantity(3)` ≈ 8.6 s later | **2 ✘** (2/2) | **0/2** | correct only after ≈ 8.6 s and a spoken stale confirmation |
| 6 | `correction_during_hold` (2.5 s hold) | "two burgers", then the correction spoken **during the hold** | **no `input.speech.started`, no `transcript.user.delta`, no `transcript.user`** during or after the hold; the first sign was a lone `input.speech.stopped` ≈ 6 s later. Server timeline: the correction *is* recorded as `user_transcript` "No, wait, make it 3." (speech 8.5–12.7 s) and the server only registered our `tool.result` when that speech ended (`result_received` 12691 ms vs our send at ~10.6 s) | **2 ✘** (2/2) | **0/2** | run 1: agent said "Got it, two classic burgers", self-corrected +12 s. run 2: agent said "I have two classic burgers", **never corrected: stale (2)** |
| 7 | `barge_in` (as built: user speech over a *silent* reply) | correction during hold-mode padding | `tool.call` (qty 2) fired **1.0 / 1.2 s BEFORE** `input.speech.started` for the correction: gate would have had no signal at all; transcript never streamed | **2 ✘** (2/2) | **0/2** | **stale (2) 2/2** |
| 8 | `backchannel` (as built: "uh-huh" over a *silent* reply) | "uh-huh" during padding | `input.speech.started` and `transcript.user` "Aha." arrived only **after** `tool.result` (2/2) (docs' "flushes after hold ends" observed here) | 2 ✔ | (not a correction) | correct |
| 9 | `barge_in_speech` (valid) | correction spoken while the agent was audibly speaking | `transcript.agent{interrupted:true}` → `input.speech.started` → `reply.done{status:"interrupted"}`, all within ≈1 ms (2/2). Flagged ≈2.5–3.0 s after our correction audio began (as the agent's sentence finished). Correction transcript then streamed normally (no hold active): "No, wait, make it 3 burgers." → `update_quantity(3)` | n/a → **3 ✔** (2/2) | **yes** (2/2) | correct |
| 10 | `backchannel_speech` (valid) | "uh-huh" while the agent was audibly speaking | **0/2 interrupted**: `reply.done{completed}`, `transcript.agent{interrupted:false}`, full sentence spoken. "Aha." became a normal user turn after `reply.done`, which triggered another agent reply | n/a | n/a | unchanged |

### Aggregate (correction runs needing quantity 3; N = 12: inline 2, late 6, during-hold 2, silent-reply barge 2)
- First `tool.call` carried the **stale quantity 2 in 9 of 12**; carried the correct 3 in 3 of 12 (inline ×2, late_400 run 1).
- Correction transcript reached the live stream **before the call in 3 of 12**, and **never in 9 of 12**.
- Order still stale at the end of the run in **6 of 12**; the other 3 stale calls were fixed only by the agent's own late `update_quantity` (≈ 8.6–12 s later), after speaking the stale quantity to the customer.

## 3. Findings
| # | Finding | Evidence |
|---|---|---|
| F1 | **Hold mode keeps the agent silent before the first `tool.call`.** Between end of user speech and `tool.call` the server streams `reply.started` + **silence** frames (RMS≈0). No audible speech, confirmed by RMS and by transcribing the stereo recording (first agent words after the greeting were after the tool results). **`reply.started` is NOT speech** (analyzer and D-02 must use audio energy). | scenarios 1–6; recording transcription |
| F2 | **Transcript delivery for speech that overlaps a hold is unreliable, not merely late.** 9/12 correction transcripts never appeared in the live stream, though the server recorded them and the LLM used them (later `update_quantity(3)`). Docs say transcripts "flush after hold ends"; observed: either never, or only for very short utterances ("Aha."). | table rows 3–7; server timelines |
| F3 | **`input.speech.started` is not a dependable early warning.** It preceded `tool.call` by 115–980 ms in the five late runs, fired **1.0–1.2 s after** it in `barge_in`, and **never fired during the hold** in `correction_during_hold`. VAD lag from audio start: p50 ≈ 1.8 s, p95 ≈ 3.0 s (client-observed; upper bound, includes synthetic-clip lead-in). | stats; rows 4–7 |
| F4 | **The reference agent confirms stale values aloud.** After committing qty 2 it said "Okay, two burgers", "Got it, two classic burgers", "I have two classic burgers" to a customer who had said three. This is the exact failure Tally targets. | rows 4–6 |
| F5 | **The model does not always fix it.** 6/12 correction runs ended with the wrong quantity committed and spoken. | aggregate |
| F6 | **Inline corrections are handled correctly by the LLM** (3/3 correct incl. late_400 run 1). Scenario B as written ("claims 2, transcript shows 3") is only naturally reproducible via a *late* correction. | rows 2–3 |
| F7 | **Barge-in ordering (pins D-02):** `transcript.agent{interrupted:true}` **precedes** `input.speech.started`, then `reply.done{interrupted}`, all ≈1 ms apart. The derivation "speech.started during a reply, followed by `reply.done` = interrupted" holds; do not depend on `transcript.agent` ordering. Detection fired ≈2.5–3.0 s after our audio began, coinciding with the end of the agent's sentence, so we did **not** observe mid-sentence truncation (N=2, synthetic clips). | row 9 |
| F8 | **The server distinguishes backchannel from interruption** ("uh-huh" over speech: 0/2 interrupted). But the backchannel is still transcribed as a **new user turn** afterwards and triggers another agent reply. | row 10 |
| F9 | **Every inbound event carries a server `timestamp` (Unix seconds).** This corrects DECISIONS D-05 / PRD G3, which said there were none. Server-side ordering is available and should be used alongside client stamps. | raw events |
| F10 | **Stored timelines carry `user_confidence`** (observed `1`) plus `user_speech_started/ended_at_ms`, `tool_calls[].dispatched_at_ms/result_received_at_ms`. Post-hoc only; **not** in the live stream. Corrects D-03 in part (a confidence exists post-hoc; it was uninformative here). | session timelines |
| F11 | **Sequential single-item tool calls.** An order of two items became separate calls, each in its own silent reply. Model also issued a duplicate `add_item(coke)` and, in run 1, an unrequested `size_large` modifier: real unsupported-claim examples for Step 14. | rows 1 |
| F12 | **Latency is dominated by turn detection and model time, not gating.** End of customer's words → `input.speech.stopped` ≈ 1.2–2.4 s; `tool.call` ≈ 1.5–2.5 s after that. p50 speech-end → first agent audio ≈ 2.7 s, p95 ≈ 8.4 s (client-observed, includes hold padding). Gating overhead is negligible next to this (`hold_ms` p50 < 1 ms with the stub). | stats |

## 4. Verdict table (per the Step 3 checklist)

| Item | Finding | Result |
|---|---|---|
| Hold mode keeps agent silent before `tool.call` (H1) | Yes, for the first call in a turn: only silence padding streamed | **PASS** |
| Order of `tool.call` vs finalised `transcript.user` | Correct for single-utterance turns (`tool.call` ≈1.5 s after final). When a correction begins after the first utterance, `tool.call` fires **before** the correction is finalised in **7 of 8** late/hold runs (the exception: late_400 run 1, where the model waited) | **FAIL** for corrections |
| Speech events fire during hold | `input.speech.started` **did not fire at all** during a 2.5 s hold (2/2); in silent-reply runs it fired 1.0–1.2 s after `tool.call` | **FAIL** |
| Correction-during-hold visibility before `tool.result` is due | 0/2 speech signal, 0/2 transcript | **FAIL** |
| Correction transcript reaches the live stream at all (late/hold, N=8) | 1/8 | **FAIL** |
| Interrupted-turn event ordering (pins D-02) | Captured 2/2; derivation confirmed; `transcript.agent{interrupted}` precedes `speech.started` | **CAPTURED** |
| Backchannel does not interrupt | 0/2 interrupted | **PASS** |
| p50 / p95 silence in hold mode (speech end → first agent audio) | ≈ 2.7 s / ≈ 8.4 s | **WARN** (turn detection + model, not gating) |
| **Overall: hold-mode as designed** | Evidence for corrections is not delivered on the live stream when it matters | **NO-GO** |
| `GATE_BUFFER_MS` decision | **A buffer alone does not solve this** (see §5); not set | *needs decision* |

## 5. Why a buffer window is not enough
The owner's fallback was "add a buffer window before Step 5". The data says that would not help by itself:
1. A buffer waits for evidence to *arrive*. In 9/12 correction runs the transcript never arrives on the live stream, however long we wait (observed 4–17 s after `tool.call`, with the transcript present in the server's own timeline).
2. A signal-only buffer (wait for `input.speech.started`) needs > 3 s to cover the observed p95 VAD lag, and in `correction_during_hold` no signal fires at all.
3. Failing closed on "no evidence" would hold nearly every call, because absence of a transcript is the normal case here (false-positive rate ≈ 100% on late corrections), which defeats the demo and metric 8.

Fail-closed is preserved either way: nothing is allowed on missing evidence. The problem is that hold-mode's live event stream cannot *supply* the evidence Tally must judge against.

## 6. Options (owner decision required; I have not started any of these)
| Option | What it gives | Cost / risk | Consistent with prior decisions? |
|---|---|---|---|
| **A. Tally-owned independent STT stream** on the same input audio (Universal-3.5 Pro streaming API) as the *evidence source* for gating | Evidence independent of hold-mode suppression and of the agent's LLM; also yields real confidence | +$0.45/h; new component; schema unverified (must be spiked first); adds a second transcript to reconcile | **No: reverses the D-04 deferral.** Needs your explicit approval, and its purpose changes from "confidence" to "evidence availability" |
| **B. Test interactive mode** for mutating tools (one flag, 1 short spike) | May stream transcripts normally | Agent may speak "let me check…" before validation (weakens the fail-closed premise); untested | Would revise D-01 |
| **C. Post-hoc reconciliation from the server timeline** (`GET /v1/sessions/{id}` has the transcript) | Detects stale commits after the call; still feeds RECORD FAILURE → REPLAY → IMPROVE | Detection not prevention; timeline availability mid-call unverified | Compatible; but would drop live prevention from the demo |
| D. Speech-activity signals + buffer only | Cheap | Demonstrably blind in 5/12 runs (F3) | Not viable alone |

**Recommendation:** NO-GO on hold-mode as designed. Approve **A** (spiked first: verify the streaming schema, latency and that it hears the corrections the agent's stream lost) and run **B** as a cheap comparison, keeping **C** as the safety net. If A verifies, hold-mode remains useful (it keeps the agent silent until validated), with Tally judging against its own evidence. I will not begin Step 5, and will not scope A, until you decide.

## 7. Limits of this evidence (stated up front)
- **N = 2 per scenario**, 20 valid sessions. The pattern is consistent (run 1 showed it too), but this is a feasibility spike, not a rate estimate. Do not quote "9/12" as a production failure rate.
- Synthetic SAPI voice, clean audio, single speaker; real callers add noise and overlap. The synthetic clips have some lead-in silence, so VAD-lag figures are upper bounds.
- All timings are client-observed (network included); server `timestamp` fields exist and should be used in Step 4.
- The LLM is not seedable; outcomes vary run to run (e.g. late_400: 1 correct, 1 stale).
- Run 1 is contaminated (§1) and excluded from all numbers.
- One recording transcription (`clean_order-1`) was used to confirm silence-before-call; not repeated for every run (RMS covers the rest).
