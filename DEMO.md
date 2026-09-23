# Tally — Demo Script (16 beats)

Traces to brief §17 and PRD Step 15. Every beat names the loop stage it shows and the exact action. **Read "What is real and what is scripted" before you speak to anyone.**

## What is real and what is scripted (say this out loud early)
| | Deterministic demo (default, offline) | Live call (real agent) |
|---|---|---|
| Audio | prerecorded, checked-in, synthetic (SAPI) clips (`demo/clips`, hashes pinned) | your microphone, or the clips |
| Recorder, local speech check, evidence tracker, gate, committer, drift check, repair loop, cases, tagger, replay, promotion gate, metrics, SQLite | **real** | **real** |
| Voice Agent (decisions and speech) | **scripted** (identical every run) | AssemblyAI's managed agent (not seedable) |
| "Independent" transcripts | **scripted** (a fixed transcript per clip) | AssemblyAI streaming STT |
| Result | identical verdicts, orders, cases and counters on every run (tested) | varies; audio-tier replay is reported "k/3 passed" |

The dashboard shows the banner **"DETERMINISTIC DEMO: … scripted agent"** whenever a scenario is playing. The deterministic mode proves the *pipeline*; it says nothing about how the live managed agent behaves (see "Validation status").

## Setup (before going on stage)
```
cp .env.example .env            # fill ASSEMBLYAI_API_KEY and TALLY_OPERATOR_TOKEN (>= 16 chars); the key is read by the server only
npm install
npm run demo:seed -- --fresh    # ~90 s: plays A, B, D and the confidence scenario x3 through the real pipeline, then ONE operator acceptance
npm run serve                   # builds the dashboard and serves it with the API at http://127.0.0.1:8787
```
Open `http://127.0.0.1:8787`, enter the operator token (kept in the tab only, sent as a header, never in a URL).
The seed leaves: config **v1** active, **v2** (weakens the confidence floor) created and BLOCKED by a real regression case, **v3** (only the wait budget changes) created and passing, cases logged, 3 confidence cases → regression candidates → **one accepted as a regression by the operator**. Nothing is fabricated: every case came out of the pipeline; the only manual act is the acceptance, and it is audit-logged.
Offline fallback: everything above works with no network (deterministic mode). Live mode needs the AssemblyAI key and network.

Wording rules: say **"barge-in derived from AssemblyAI's interruption events"**, not "AssemblyAI barge-in event". Say **"auto-generates a regression *candidate*; the operator accepts it"**, not "the model learned". Evidence-tier replay is **"deterministic PASS/FAIL"**; audio-tier replay is **"k/3 passed"**, never "deterministic".

| # | Beat | Loop stage | Action | What must be visible |
|---|---|---|---|---|
| 1 | Open on the dashboard | — | Load the page, sign in | Counters: cases 6+ (from the seed), regressions 1; Live tab empty |
| 2 | Order two burgers and a coke | LISTEN | Live tab → **Play scenario: A** (or **Start live call** and speak) | Transcripts stream; three tool calls appear on the timeline |
| 3 | Timeline goes green | VALIDATE→ALLOW | (no action) | Green ALLOWED bars with text labels; order panel **2 classic burgers, 1 coke, $20.47, confirmed** |
| 4 | Second call: interrupt "no wait, three" | LISTEN | **Play scenario: B** | Customer speech segments; the agent's reply segment marked "cut off" |
| 5 | Point at the ◆ marker | LISTEN/EXTRACT | Hover the barge-in diamond | Tooltip: derived from customer speech during an audible reply + the interrupted reply, **both source event ids** |
| 5b | **The gate visibly WAITS** | VALIDATE (evidence) | (slow this beat down on purpose) | Grey **⏳ WAITING ON INDEPENDENT EVIDENCE** chip with a live countdown (`x.x s / 4.0 s`); the **Independent stream** column fills in *"No, wait, make it three."* while the order panel stays unchanged. **In the deterministic demo the Voice Agent column stays EMPTY for the whole call** (the scripted agent emits no recognizer transcript), so do not say it "has not caught up"; in a LIVE call that column shows what the managed agent's own recognizer heard, which is what can lag or miss the correction. Say: *"The agent already asked to add two. Tally isn't allowed to trust that. It is waiting for what the customer actually said."* Do not skip: a silent instant fix proves nothing about the mechanism. |
| 6 | The call flips to CONFLICT | VALIDATE | (no action) | `CONFLICT QTY_MISMATCH` with the measured wait (`held 2.x s`); order panel still shows no burger |
| 7 | Repair question | REPAIR | (no action) | Call-log line `REPAIR: "Just to confirm, that's 3 classic burgers?"` (Tally supplied the instruction; the agent speaks it) |
| 8 | "Yes, three" → ALLOWED | ALLOW | (scenario continues) | `ALLOWED · REPAIRED` (yellow, labelled); order panel **3 classic burgers $26.97**; other items untouched |
| 8b | **Fail closed: the evidence stream dies** | VALIDATE (fail closed) | **Play scenario: dropout** | Red **⛔ EVIDENCE STREAM DOWN → calls are HELD (fail closed)** within a fraction of a second, not after the 4 s timeout; `HELD UNVALIDATABLE`; order empty. Say: *"No evidence, no commit. It doesn't hang and it doesn't guess."* |
| 9 | The case was logged | RECORD FAILURE | Watch the **Cases** counter | Counter increments; call log line `CASE logged: QTY_MISMATCH · add_item · customer correction, after the item was named` |
| 10 | Open the stored case | RECORD FAILURE | **Cases** tab → open it → **Load recording** | Audio player, transcript snapshot, stored evidence, expected state in words |
| 11 | Replay it | REPLAY | **Replay: evidence tier** then **audio tier** (deterministic mode: scripted agent) | Evidence: **PASS (deterministic)** with a diff table. Audio: **3/3 passed** (≈3× the clip; say it is the scripted agent) |
| 12 | The same pattern again | RECORD FAILURE→IMPROVE | **Play scenario: D** (three corrections) | **On a seeded database D has already been played by the seed**, so this ADDS three more cases with the same pattern (the Cases counter jumps by 3 and the candidate counter grows); it does not show "two more". For a first-time story, seed with `npm run demo:seed -- --fresh` and skip beat 12, or start from a database that has no D cases. |
| 13 | Candidates, then the operator decides | IMPROVE | Cases tab → a resolved candidate → **Accept as regression (operator)** | The candidate counter is already above 0 from the seed (and grows after beat 12); accepting one raises **Regressions** by 1. Say: *"Tally generates the candidate; a person promotes it. A wrong regression would block real fixes."* |
| 14 | Promotion is blocked, naming the case | IMPROVE | **Lab** → v2 → **Run all cases** | **BLOCKED**: the regression case, its pattern, `SAFETY_REGRESSION_now_allowed_but_must_be_held`; **no Promote button**; the validation notice stays visible. Then v3 → Run all cases → PASSED → **Promote**; **Roll back** returns to v1. The compare table shows real PASS/FAIL cells per case × version |
| 15 | Close on the numbers | IMPROVE | **Metrics** tab | Per-stage p50/p95 (client-observed), conflict rate, repair success, false-positive holds, regression pass rate, **final order accuracy n/N** computed from stored runs: state the real number |
| 16 | Closing line | — | (spoken) | "Every voice agent claims it got the order right. Tally is the one that checks." |

## Beat-level fallbacks
- **Mic misbehaves / no network:** use the scenario buttons; the pipeline is identical.
- **A live agent does not misread on demand** (the managed model is not seedable): the dashboard honestly shows a clean pass; use scenario B or the confidence scenario, which are labelled as scripted.
- **Latency:** measured (spike-g5/A): end of customer speech → first agent audio ≈ 2.7 s p50 / 8.4 s p95, dominated by the agent's own turn detection and model time, not gating. When the gate has to wait for evidence the wait is on screen (beat 5b), bounded at 4.0 s. Do not promise "sub-second".
- **If doing a real live-mic call (not the scripted scenarios), do not rapid-fire repeated corrections** (e.g. "two... no three... no four... no five" back to back). Confirmed live (`docs/live-repair-validation.md` Part 2, Session 2): stacking corrections faster than the 4 s independent-evidence wait can keep resolving is **correctly handled** — the gate holds each attempt and eventually escalates to a hand-off rather than ever guessing — but it reads as the call getting stuck, not as a clean resolve, and is a worse demo beat than beat 5b's single correction. For beat 5b, say the correction once ("no wait, make it three") and let it resolve; the single-correction path from the human session is the clean, repeatable demo beat. Rapid-fire stacking is a good thing to show ONLY if the point being made is fail-closed-under-stress, not the normal repair flow.

## Determinism statement for judges
- Same fresh DB + same clips + same config ⇒ same **gating verdicts, order state, cases, tags and counters** (tested by playing A, B, confidence and dropout twice and comparing byte-for-byte; D and C are asserted structurally).
- Evidence-tier replay is byte-identical run to run. The managed agent's phrasing is not seeded and is never claimed deterministic; audio-tier results are k/3.

## Hold-state visibility rules (owner decision, 2026-09-20)
- "Waiting on independent evidence" is a first-class UI state: chip, live countdown against `EVIDENCE_WAIT_MAX_MS` (4.0 s), both transcripts side by side, for the whole wait.
- The fast path stays fast and honest: when nobody is speaking the gate does not wait, and the dashboard shows the call without a chip rather than hiding the check.
- Never present a hold as a failure of the customer or a bug: the chip says what Tally is waiting for and why.
- Beats 5b and 8b are mandatory.

## Validation status (say this if asked; it is also on screen in the Lab tab)
| Item | Status |
|---|---|
| Real-speech validation pass (3+ human speakers, 10+ recordings each, criteria fixed in advance) | **NOT RUN.** Tooling, protocol and criteria are ready (`docs/real-speech-validation.md`); it needs a date and recruited speakers. Until it runs, accuracy claims are limited to synthetic and captured phrasing. |
| Live-agent repair loop | **Run once, automated** (`docs/live-repair-validation.md`): real agent, real STT, synthetic customer voice, holds induced by fault injection. It found and fixed one issue (the agent changed a number in the repair question). |
| Live **human microphone** session | **Run 2026-09-23, two sessions** (`docs/live-repair-validation.md` Part 2): real person, real mic, real managed agent. Session 1: correction caught, held correctly, repair question fired and resolved correctly (3 classic burgers, $26.97), case stored correctly. Session 2: barge-in derived correctly over the agent's speech; rapid repeated corrections correctly escalated to a hand-off rather than committing a guess (order stayed $0.00, never wrong); spoken-drift correction (Step 10) fired and was spoken verbatim by the real agent. All four repair-loop checks (scoped question, re-validated resolution, escalation, barge-in) are now confirmed against real human speech at least once. Follow-up: Session 1's case (`bbc2f4a7`) was then audio-tier replayed against the real managed agent — 3/3 passed. |
| The promotion gate's regression suite | Synthetic and captured phrasing only; a pass means "no known failure regressed", not "reliable on real callers". |

## Demo-lock gate (owner decision, 2026-09-20)
The demo may not be locked until every item in TASKS.md "Demo lock gate" is either **passed** or **shown here and on screen as a known limitation**. Nothing is silently "done".
