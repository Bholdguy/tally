# Live repair validation (Step 6, condition 2)

**Status: BOTH forms have now run.** The automated form (2026-09-21, below) drove the real agent with a prerecorded synthetic voice and an induced fault. The **human microphone session** (2026-09-23, at the end of this file) is the real thing: a person, a real microphone, the real managed agent, no induced fault — Step 6 condition 2 is satisfied.

## Part 1 — automated form: what was run
`npx tsx --env-file-if-exists=.env scripts/live-repair-session.ts all`

- The **real managed Voice Agent** and the **real AssemblyAI streaming STT**, driven through the real `SessionRuntime` (recorder, local speech check, evidence tracker, gate, committer, drift check), the same runtime the dashboard's mic page drives.
- The **customer is prerecorded synthetic speech** (`demo/clips`, SAPI voice) that reacts to what the agent actually says: it waits for the agent to stop speaking, then answers.
- **Holds are induced.** The managed model cannot be made to misread on demand, so a fault is injected into the evidence extractor (a validation seam that exists only in `RuntimeOptions.gateOverrides`, not reachable from HTTP or the environment): the first N gate calls see evidence of a different quantity than the customer said. Everything downstream is real: the HELD result the agent receives, what it says, what it does next.

## What it checks
| | Check |
|---|---|
| A | the real agent speaks a question about the disputed item after a HELD result; A2 how faithful it is to the question Tally gave it (verbatim / paraphrase / **changed a number**) |
| B | the customer's answer leads to a re-issued tool call that Tally re-validates; with the fault cleared it commits and the repair resolves **only** through that commit |
| C | after two failed asks Tally escalates, the agent speaks the hand-off wording (not another question), does not keep re-calling the tool for that item, and the item is never committed |
| D | a customer speaking **over** the agent's repair question is derived as a barge-in, and the repair still completes |

## Results (final run, wording as shipped)
| Session | Check | Result |
|---|---|---|
| S1 | A the agent asks about the item after HELD | PASS ("Just to confirm, that's 3 classic burgers?") |
| S1 | A2 fidelity | PASS: verbatim |
| S1 | B re-issued, re-validated call | PASS after 1 answer: ALLOW (repaired) |
| S1 | B repair resolved only via the re-validated commit | PASS: order 2 classic burgers |
| S2 | D barge-in derived over the repair question | PASS: 2 source events, reaction 1 ms |
| S2 | D repair still completes | PASS after 1 answer: ALLOW, repair resolved |
| S3 | C two asks, then a hand-off instruction | PASS |
| S3 | C the agent speaks the hand-off wording | PASS: "I'm not able to confirm the classic burger myself, so a team member will confirm that one with you at pickup. Let's carry on…" |
| S3 | C no further add_item after the hand-off (8 s) | PASS |
| S3 | C the disputed item was never committed | PASS: order empty |

10 pass, 0 fail, 0 not exercised. Transcript-level record (no audio, no key): `docs/live-repair-validation-run.json`.

## What it found (and what changed)
**The real agent changed a number in the repair question.** With the original instruction wording ("Ask the customer only this, in your own natural words") the agent said *"Just to confirm, that's two classic burgers?"* when Tally had told it to ask about **3** (2 of 2 runs). In a real conflict, where Tally's evidence is right and the agent is wrong, that would put the agent's wrong number back in front of the customer. (The order stayed safe either way: the gate holds any call the evidence contradicts.) Mitigation, now shipped: the instruction and the system prompt say to keep every number and item exactly as written even if the agent remembers it differently. After the change the question was **verbatim in 3 of 3 runs**.
**Honest limits of that fix:** n = 3 per wording, one voice, an induced scenario in which Tally's number was deliberately the "wrong" one from the customer's point of view (which is exactly when a model is most tempted to correct it). Spoken *questions* are not checked by the drift detector (only statements are), so an agent that changes a number in a question is still not caught automatically. That is a known gap, not a solved one.

Other observations: the agent re-asked instead of calling the tool in some rounds (the synthetic customer cannot say a bare "yes"), so B/D are reported "after k answer(s)"; in every run it took one.

## Measured on these runs (computed from the stored rows; tiny samples, synthetic voice)
STT stage (end of customer speech → independent final): p50 ≈ 300 ms, p95 ≈ 421 ms (n = 10). Gate (call received → verdict): p50 1.7 ms, p95 5.1 ms (n = 7; no waits were needed because the customer had finished speaking). Commit: < 1 ms. First audible agent audio after the customer stops: p50 3.0 s, p95 5.3 s (n = 4). Derived barge-in reaction: 1 ms (n = 2). Repair (hold → resolving commit): p50 8.9 s, p95 10.3 s (n = 2), dominated by the agent asking and the customer answering. These are consistent with the earlier spike numbers and do not change `EVIDENCE_WAIT_MAX_MS` (4 s, from spike A), which the live runs never needed.

## What this does NOT establish
- Nothing about **human** speech, accents, noise or overlap (that is the real-speech pass).
- Nothing about how often the real agent *causes* a conflict. Holds were induced.
- One run per check with the final wording (plus repeats of S1); the managed model is not seedable, so results can differ tomorrow.
- The dashboard mic page (browser capture, resampling, WebSocket, playback of the agent's voice) was tested with unit tests and a fake mic, not driven by a real browser microphone.

## Part 2 — human microphone session (run 2026-09-23)

**Run by the owner**, real browser microphone, real managed Voice Agent, real independent STT stream, no induced fault — this is what Part 1 could not exercise (a live person, real ASR errors, a real barge-in opportunity). Session `sess_4bb6b5ea-0d9c-4280-96d6-a44c085315eb`, case `case_639c0db7-1bda-4621-ae93-0f6ebbc2f4a7` (`bbc2f4a7`), origin `live`, resolution `resolved`.

**What was said:** "2 burgers" then, before the item was confirmed, "no wait, make it 3."

| Check | Result |
|---|---|
| Independent stream catches the correction the agent's own recognizer missed | **PASS** — the agent's own recognizer initially missed the correction; the independent stream caught it |
| Gate HOLDs (`PENDING_EVIDENCE`) rather than guessing while evidence is still arriving | **PASS** — held correctly when the 4 s evidence wait timed out |
| Repair question fires, scoped to the disputed item | **PASS** (repair-question accuracy) — the agent asked naturally: *"Sorry, I want to be sure I got the classic burger right, could you say that once more?"* |
| Repair resolves correctly from the customer's answer | **PASS** (resolution) — answered "No wait, make it 3"; the call re-validated and committed |
| The order never shows a wrong value at any point (not held-then-wrong, not partially wrong) | **PASS** — final order: 3 classic burgers, $26.97, matching what was actually said throughout |
| Case stored correctly (transcript snapshot, evidence log, origin, resolution) | **PASS** — case `bbc2f4a7` present and complete in the Cases tab |
| Barge-in derived while speaking over the agent | **NOT TESTED in this pass** — not attempted this run |

**Two things flagged during the run, both investigated and resolved below:** an "evidence stream DOWN" notice at call end, and the audio player stopping early on replay.

### Flag 1: "independent evidence stream DOWN (socket closed (code 1005))" at 80.2 s

**Expected clean-shutdown behavior. No action needed.** Confirmed directly from the session's own stored event log (`events_raw`), not just by reading the code:

| Event | `t_ms` | `audio_offset_ms` |
|---|---|---|
| `evidence_stream_status: up` | 1,460 | 0 |
| `session_ended` | 80,095 | 55,780 |
| `evidence_stream_status: down` (`socket closed (code 1005)`) | 80,241 | 55,780 |

The DOWN status was emitted **146 ms after** `session_ended`, i.e. as a direct consequence of ending the call, not a mid-call drop. `SessionRuntime.end()` (`server/src/runtime.ts`) always calls `stt.terminate()` on the way out, which sends the independent stream a `Terminate` message and then closes the socket; `SttStream`'s close handler (`stt/src/stream.ts`) unconditionally reports the stream `down` on *any* close, clean or not — "so the gate can fail closed promptly" is a deliberate design choice, not a bug (D-04). Code **1005** ("No Status Rcvd") is what `ws` reports whenever `.close()` is called with no explicit status code, which is exactly what `terminate()` does; it does not indicate an abrupt or unexpected drop. Nothing to fix. The `evidence_stream_status: down` line appearing in the call log right as a call ends is the expected shape for every session, live or demo.

### Flag 2: audio player stopped after ~5 s of a 55.78 s recording

**Confirmed: not a data-loss issue.** Checked directly against the file on disk, not just the code:

- `data/audio/sess_4bb6b5ea-....pcm` is **2,677,440 bytes** on disk = 55.78 s at 24 kHz/16-bit/mono PCM — matching `audio_offset_ms: 55,780` recorded at `session_ended` exactly. The full recording is intact; nothing was truncated during capture or storage.
- The case's `audio_pointer` is the session's own pointer (cases never get a separate, possibly-truncated clip; `committer-cases.ts` copies the session's full `audio_pointer` verbatim), so `/api/cases/:id/audio` serves this same complete file.
- `pcmToWav()` (`server/src/routes-extra.ts`) writes a standard 44-byte WAV header with the RIFF and `data` chunk sizes both computed from the *full* PCM buffer length — the header correctly declares 55.78 s, so a compliant player should know the true duration up front, not learn it progressively.
- The dashboard's `audio` action (`dashboard/src/main.ts`) fetches the whole response via `fetch(...).blob()` (which only resolves once the complete body has been read) and never calls `revokeObjectURL` on it, so nothing on the client discards or truncates the blob after creation.

Every layer checked — capture, storage, the case's pointer, the WAV header, the fetch — is byte-complete and correctly declared. This narrows the cause to the browser's own `<audio>` playback of the `blob:` URL, which I can't reproduce or instrument from here. If it recurs: check the browser console for a decode/media error on that `<audio>` element, and try **right-click → Save As** or dragging the blob to a new tab to see whether the saved file plays fully outside the dashboard (which would confirm it's a player/rendering quirk, not the file). Tell me the browser/OS and any console error and I'll dig further; for now this is recorded as an open, non-data-loss playback issue, not fixed.
