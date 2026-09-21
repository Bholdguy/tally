# Live repair validation (Step 6, condition 2) — automated form

**Status: run and recorded (2026-09-21). NOT a human-microphone session, and not a measurement of evidence accuracy.** The human-on-a-microphone session is still pending on the owner (see the end).

## What was run
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

## Still pending on the owner: the human microphone session
1. `npm run serve` (it builds the dashboard), open `http://127.0.0.1:8787`, sign in with the operator token.
2. **Start live call**, then **Use microphone** (allow the browser prompt). Wait for the agent's greeting to finish.
3. Say: "Two burgers, no wait, make it three." Watch the timeline (beat 5b), the REPAIR line, the order panel.
4. To provoke a repair reliably the managed agent may need help; if it gets the order right, that is a clean pass. Speak over the agent's question once to see the barge-in marker.
5. Speak only menu items; do not say real personal data (SECURITY §1). End the call, open the case in the Cases tab, replay it.
Record what you observed in this file (date, who, what happened, including failures).
