# Real-speech validation pass: protocol, fixed criteria, schedule

**STATUS: NOT RUN.** Tooling is built and dry-run against the real APIs with a *synthetic* recording (which is excluded from the results). **Step 6 must not be called demo-ready until this has run at least once against real speech** (owner decision 2026-09-20; TASKS "Demo lock gate"; DECISIONS D-21, D-26).

## Why this exists
Everything measured so far (spike-g5, spike-a, the gate replays) used **synthetic SAPI speech, clean audio, one voice, n = 3 per scenario**. Those results are feasibility evidence, not accuracy. Unmeasured on real speech: the independent stream's accuracy on real voices and noise; the local speech check on real microphone noise (it can read noise as speech, causing a stall hold); the false-hold rate (including on `confirm_order`, the accepted D-22 trade-off); the wait-time distribution; and how the extractor copes with real hesitation, false starts and overlap.

## Schedule (needs the owner; I cannot recruit people)
| Item | Owner | Status |
|---|---|---|
| Choose date and 3+ speakers (different voices/accents where possible) | owner | ☐ open |
| Tooling, criteria, cards, consent text | Claude | ✅ done (this file, `scripts/real-speech-*.ts`) |
| Recording session (~45 min: 3 speakers x 10-12 recordings) | owner + speakers | ☐ |
| Run the batch (~30 recordings x ~40 s = ~20 min, unattended) and aggregate | Claude on request / owner | ☐ |
| Results committed to `docs/real-speech-validation-results.md`, including failures | Claude | ☐ |
The whole run costs about 20 minutes of API time at $4.50/h + $0.45/h. Recruiting is the only real cost, so this should happen as soon as the owner can name a date.

## Participants, consent, data
- Each participant agrees in writing (a message is enough) that their recording is processed by AssemblyAI (Voice Agent and streaming STT) and stored locally under `data/` (git-ignored). **Nobody speaks real personal data** (no real names, phone numbers, addresses, payment details): use the menu only (SECURITY §1). Delete recordings on request.

## What is recorded, and the ground rule
Record each card below as a mono or stereo **16-bit PCM WAV** (any sample rate; the harness resamples). Start each recording with **>= 0.5 s of silence** (used to calibrate the noise floor), and end with the closing phrase. Convert phone recordings with `ffmpeg -i in.m4a -ac 1 -ar 24000 -sample_fmt s16 out.wav`.
**Before speaking, the speaker writes the intended final order** into `NAME.intent.json` (see `scripts/real-speech-intent.example.json`). It is never derived from a transcript or from what the system did.

## Cards (each speaker records at least 10, covering 1-10, plus >= 1 noisy)
| # | Kind (`kind`) | What to say (natural variation is fine; that is the point) | Intended order |
|---|---|---|---|
| 1 | `clean` | "Two burgers and a coke. That's all, pickup as soon as possible." | burger x2, coke x1, ASAP |
| 2 | `clean` | "A burger with no onions and extra cheese, and fries with no salt. Pickup at six thirty." | burger [extra_cheese, no_onions], fries [no_salt], 6:30 |
| 3 | `inline_correction` | "Two burgers, no wait, make it three, and a large coke. That's all, as soon as possible." | burger x3, coke [size_large], ASAP |
| 4 | `late_correction` | "Two burgers." *(pause ~1 s)* "No wait, make it three." *(pause)* "And a coke. That's all, as soon as possible." | burger x3, coke x1, ASAP |
| 5 | `imperfect_correction` | False start: "Two bur-, uh, no, I mean three burgers, um, and a diet coke. That's all, as soon as possible." | burger x3, diet_coke x1, ASAP |
| 6 | `imperfect_correction` | Trailing off / mumble: "Make it, uh, two, no, three, three burgers... and fries. As soon as possible." | burger x3, fries x1, ASAP |
| 7 | `overlapping_correction` | Start the correction **before finishing the previous phrase** ("Two burgers and a co-, no wait, three burgers and a coke") **or** have a second person interject "make it three" while the first is still speaking. | burger x3, coke x1 |
| 8 | `late_correction` | Item change: "A cheeseburger. Actually, a veggie burger. That's all, as soon as possible." | veggie_burger x1, ASAP |
| 9 | `clean` | Removal: "Two burgers and fries. Cancel the fries. As soon as possible." | burger x2, ASAP |
| 10 | `backchannel` | Say "mm-hm", "uh-huh", "okay" between phrases of card 1. | as card 1 |
| 11 | `noise` | Card 1 or 4 with background TV / cafe / crosstalk at conversational level (`"noise": "tv"`). | as the card used |
| 12 | `noise` | Card 3 with a fan / traffic / kitchen noise (`"noise": "fan"`). | as card 3 |
Speaking over the **agent** (barge-in) cannot be tested from a recording, because a WAV cannot hear the agent. That, and the repair conversation, need a live microphone session (Step 11's dashboard mic page); they are outside this pass and are called out as such.

## FIXED PASS CRITERIA (written 2026-09-20, before any run; `CRITERIA` in `scripts/lib/real-speech.ts`, unit-tested)
| id | Criterion | Threshold |
|---|---|---|
| P1 | Confirmed orders that differ from the speaker's intent | **0** (zero tolerance: this is the harm that reaches the kitchen) |
| P3 | False-hold rate on valid calls (call content equals intent, but held) | **<= 15%** overall |
| P3b | Same, for `confirm_order` only (the D-22 trade-off, reported separately) | **<= 15%** |
| P4 | Independent-stream evidence reproduces the intent (extractor over its final transcripts) on clean-room recordings | **>= 95%**; every miss listed with its transcript and explained |
| P5 | Evidence wait | **every wait <= 4000 ms**; `PENDING_EVIDENCE` holds are counted and shown |
| P6 | Local-speech stalls (independent stream never acknowledged speech the local check heard) on clean-room recordings | **<= 5%**; reported per noise condition |
| P7 | Coverage | >= 3 speakers, >= 10 recordings each, each with an imperfect AND an overlapping correction, >= 3 noisy recordings in total |
**Rules:** thresholds are not edited after results exist; changing one requires a new DECISIONS entry that says why and keeps the old value beside it. Failures are committed with the results. If a criterion fails, the corresponding demo claim is **narrowed to what was measured**; spike numbers are never substituted. P1 failing means Step 6 is not demo-ready.
Additionally reported (not pass/fail): option-C reconciliation findings per recording, ingest errors, wait distribution, independent-stream word-confidence distribution, and whether the agent's own hallucinations were held (true positives).

## How to run
```
# per recording (one real-time call, ~40 s)
npx tsx --env-file-if-exists=.env scripts/real-speech-run.ts data/real-speech/recordings/A-01.wav data/real-speech/recordings/A-01.intent.json
# a whole folder (each NAME.wav needs NAME.intent.json; wavs without written intent are skipped and listed)
npm run real-speech:batch -- data/real-speech/recordings
# evaluate the fixed criteria and write docs/real-speech-validation-results.md
npm run real-speech:summary -- data/real-speech --md
```
Smoke test of the tooling (SYNTHETIC, excluded from results): `npx tsx scripts/make-dryrun-wav.ts` then run the harness with `--out=data/real-speech-dryrun`.

## Known limits of this pass (stated up front)
A recording cannot respond to the agent, so the agent's questions go unanswered and some orders remain unconfirmed (`status: open`); P1 counts only *confirmed* wrong orders, and unconfirmed mismatches are still listed. The repair loop, barge-in over the agent, and interactive turn-taking are not exercised. Sample size (~30 recordings) supports "no gross failure and a measured false-hold rate", not a tight accuracy estimate.
