# Tally — Testing Strategy

Traces to PRD Part C (every step lists its tests) and brief §16. **Rule: tests assert business outcomes** — final order items, quantities, modifiers and total match what the customer said, and `orders` is unchanged after a HOLD — not merely that a transcript or event exists.

## 1. Layers

| Layer | Tooling | Scope | Loop stage covered |
|---|---|---|---|
| Unit | Vitest | contract schemas, extractor, gate verdicts, total math, tagger, repair templates, boundary script | EXTRACT, VALIDATE, REPAIR, RECORD |
| Integration | Vitest + recorded fixtures + temp SQLite | audio-in → events → gate → commit, using **captured real AssemblyAI events** (Step 3 spike) and prerecorded PCM | LISTEN→ALLOW/REPAIR |
| E2E (UI) | Vitest + jsdom, over real HTTP + SSE against the real server (`dashboard/test/e2e.test.ts`) | scenarios B and dropout through the dashboard code; A, B, D, C, confidence, dropout through `POST /api/demo/:scenario` in `server/test/demo.test.ts` | full loop. **No Playwright and no real browser is used (D-33).** |
| Failure injection | Vitest + fault-injecting sink | dropped VAD, dropped/late `transcript.user`, mismatched tool result, malformed events, DB fault | VALIDATE fail-closed |
| Adversarial | dedicated harness (Step 14) | tool calls that lie | VALIDATE |
| Security | scripts + Vitest | secret scan, boundaries, no browser→AssemblyAI | (cross-cutting) |

## 2. Business-outcome assertions
Tests assert outcomes directly (no shared `expect*` helper library exists): final `orders.items_json`/`total` read through the store's read-only handle, an order hash before/after a HOLD (`orders` unchanged, no committed line), every order change has a paired `audit_events` row (also enforced by DB triggers), and provenance columns are populated. See `reliability/test/gate-*.test.ts`, `repair.test.ts`, `cases.test.ts`, `server/test/runtime.e2e.test.ts`, `demo.test.ts`.

## 3. Unit tests (Steps 1, 2, 4, 5, 6, 7)
- **Contract:** 6 tools × (≥2 valid, ≥3 invalid) payloads; every conflict code has a repair template + fixture.
- **Total math:** table incl. modifier deltas (`2×(899+100)+249=2247`).
- **Extractor:** ≥40 labelled utterances, e.g. "two burgers no wait make it three" → burger qty 3 (cue=correction); "for fries" → ambiguous (flag); "no onions" → removal entity; "swap the beef for chicken" → substitution; "pick up at six thirty" → pickup_time.
- **Gate table:** ≥60 `(evidence, tool_call) → verdict+code` rows; **property/fuzz test:** for any input including null evidence, malformed args, extractor throw, DB throw, timeout ⇒ verdict is never `ALLOW` unless all checks passed (asserted by a reference oracle).
- **Tagger:** same `pattern_key` ×3 ⇒ tag flips on exactly the 3rd; distinct patterns don't collide; idempotent per `tool_call_id`.
- **Repair templates:** never mention items other than the disputed one.
- **Boundaries:** script detects seeded violations (voice-output import in `/reliability`, RW connection import outside committer).

## 4. Integration tests (Steps 3, 4, 5, 10)
Fixtures under `fixtures/`:
- `aai-events/*.jsonl`: real captured event streams (clean order, hold-mode with mid-hold correction, interrupted turn), produced by the Step 3 spike.
- `fixtures/aai-events*/` real captured event streams and stored timelines (spike A/B); `fixtures/audio/spike/*.wav` synthetic SAPI clips used by the spike and the real-speech dry run; `demo/clips/*.wav` (pinned hashes) used by the deterministic demo.

Assertions: event completeness (each `tool.call` has ≥1 finalised `transcript.user` and a speech start/stop pair in its window); derived barge-in appears exactly when `input.speech.started` occurs during a reply that ends `interrupted`, and **not** when the reply completes (backchannel); scenario B end-to-end final order + total; other items untouched by repair.

## 5. Replay testing: the two-tier distinction (approved decision)
| Tier | What runs | Verdict wording | Test |
|---|---|---|---|
| **Evidence tier** (stored-event replay against current gating code) | stored event snapshot → current ingest/extract/gate | **deterministic PASS/FAIL** | run twice ⇒ byte-identical `diff_json` and verdict; known-fixed case ⇒ PASS; deliberately broken gate build ⇒ FAIL |
| **Audio tier** (live audio + managed agent) | stored PCM at 1× → fresh live session | **"3/3 passed"** (or "2/3 passed" = FAIL). *Never called deterministic* because the managed LLM cannot be seeded | assert k results stored; assert one failure among k ⇒ overall FAIL; assert UI/API strings never contain "deterministic" for this tier |

Promotion gate: the evidence tier must be 100% PASS for every regression-tagged case; the audio tier (k/k per case) is required when the prompt or tool schema differs from the parent (D-31), optional otherwise. The evidence tier cannot see a prompt change.

## 6. E2E (Step 11, 15)
The dashboard code is driven through jsdom (over real HTTP + SSE in `dashboard/test/e2e.test.ts`); scenarios run through `POST /api/demo/:scenario` using prerecorded audio through the **real** pipeline with a SCRIPTED agent and transcripts (D-34).

| Scenario | Asserted business outcomes |
|---|---|
| A clean | 2 allowed tool calls; order = 2×burger + coke; total 2047; no held calls; all-green timeline |
| B recover | timeline shows barge-in marker (derived), red CONFLICT then yellow repaired then green; repair prompt scoped to burger; final qty 3; total 2697 (+ coke if ordered); 1 new case with audio file present |
| C replay | B's case replayed at the evidence tier against v1 and v2 (deterministic PASS on both), audio tier through the scripted agent shows "3/3 passed" (proves the runner, not the real agent) |
| D learn | three runs of the same correction pattern: three real cases share one `pattern_key` and all become `regression_candidate` on the 3rd; a regression appears only when the OPERATOR accepts one (D-29); no rows are created outside the pipeline (each case's session has stored events and a recording) |

Also: no browser code path can address `assemblyai.com` (source and bundle scans, `server/test/privacy.test.ts`); identical normalised output when run twice from a fresh DB (`server/test/demo.test.ts`); the same identity over HTTP against a running server (`npm run smoke:deployed`).

## 7. Failure injection (Steps 4–6, 14)
| Injected fault | Expected outcome |
|---|---|
| Mismatched tool result (handler returns qty 3, DB wrote 2) | `TOOL_RESULT_LIE`, held/flagged; order state asserted |
| Wrong qty / wrong item / phantom add | `QTY_MISMATCH` / `ITEM_MISMATCH` / `UNSUPPORTED_CLAIM`; `orders` unchanged |
| Dropped local speech end / silent independent stream | the local speech check sees speech the independent stream never acknowledges: stall after `STT_STALL_MS` ⇒ `UNVALIDATABLE` HOLD (never ALLOW) |
| Late or missing agent-stream `transcript.user` | irrelevant to the decision (the agent stream is not evidence); a late INDEPENDENT final is waited for up to `EVIDENCE_WAIT_MAX_MS`, then `PENDING_EVIDENCE` HOLD |
| Malformed event / missing required field | stored raw with a `parse_warning` event; the gate is unaffected (there is no `evidence_degraded` flag) |
| Duplicate `call_id`, out-of-order events | idempotent; no double-commit |
| Extractor exception / DB exception | `UNVALIDATABLE` HOLD (the gate is a total function; there is no separate gate timeout) |
| Slow tool (800 ms) | stage p95 rises in metrics |

## 8. Metrics-truth tests (Step 12)
Each dashboard metric is recomputed from raw rows in a test and compared. No hard-coded numbers (rule 5). Latency labelled *client-observed*.

## 9. Step 3 spike verification (blocking gate)
Not a pass/fail unit test but a written report, `docs/spike-g5.md`, from captured fixtures: hold-mode ordering, correction-during-hold behaviour, interrupted-turn ordering, latency of the silent-pause. Step 5 tests may not be written before the report exists.

## 10. Commands
```
npm test                 # unit + integration
npm run demo -- A|B|C|D|confidence|dropout|all   # deterministic scenarios
npm run demo:seed -- --fresh               # demo data incl. one operator-accepted regression
npm run smoke:deployed -- <url> <token>    # black-box checks against a RUNNING server (--dry writes nothing)
npm run adversarial      # Step 14 harness
npm run check:boundaries # architecture boundaries
npm run scan:secrets
npm run spike:g5         # Step 3 live capture (needs ASSEMBLYAI_API_KEY)
```
There is **no CI**. The order used by hand: `npm test` (boundaries → vitest: unit, integration, adversarial, dashboard), `npm run scan:secrets`, `npx tsc -p tsconfig.json --noEmit`, then `npm run smoke:deployed` against any deployment.

## 11. Real-speech validation pass (REQUIRED before demo lock; separate from unit/integration work)
**Why:** every number in `docs/spike-g5.md` and `docs/spike-a.md` comes from **synthetic Windows-SAPI speech, clean audio, one speaker, n = 3 per scenario (A) / 2 (B)**. "18/18 corrections delivered" is a feasibility result, not an accuracy rate. The independent stream's real-world accuracy, the local speech-activity check's behaviour on real microphone noise, and the gate's false-hold rate on real speech are all **unproven**. This pass is a **hard gate for final demo lock** (TASKS "Demo lock gate"), separate from Step 4's unit/integration tests and from Step 5's suite.

**Protocol**
- ≥ 3 human speakers (different voice/accent where possible), real microphone, normal room noise; ≥ 10 orders per speaker.
- Must include, per speaker: clean orders; **inline corrections**; **late corrections** (correction after a pause); **at least one deliberately imperfect correction** (restart, false start, "uh… no, I mean…", trailing off) and **at least one overlapping correction** (speaking over the agent's reply / over the customer's own previous phrase); a backchannel ("mm-hm") while the agent speaks; background TV/crosstalk in a few runs.
- Ground truth: the tester writes down the intended final order *before* each call (items, quantities, modifiers, pickup). Assertions compare committed state to that, **not** to any transcript.
- Measured on real audio: (1) independent-stream final transcript contains the intended quantity/item (accuracy, per-word confidence distribution); (2) **local speech-activity check**: onset lag, end-of-speech lag, false triggers on room noise, misses; (3) wait time distribution vs `EVIDENCE_WAIT_MAX_MS`; (4) **false-hold rate** (valid calls held) and **missed-conflict rate** (stale commits allowed, must be 0 on the seeded conflicts); (5) reconciliation (option C) findings.
- **Pass criteria are FIXED and live in `docs/real-speech-validation.md` and `scripts/lib/real-speech.ts` (`CRITERIA`, unit-tested):** P1 zero confirmed wrong orders; P3/P3b false-hold rate <= 15% (overall and confirm_order); P4 evidence accuracy >= 95% clean-room; P5 every wait <= 4000 ms; P6 stalls <= 5% clean-room; P7 coverage (3+ speakers x 10+ recordings, imperfect + overlapping correction each, 3+ noisy). Written before any run; not editable after results exist. This bullet supersedes the earlier looser wording.
- If the pass fails a criterion, the demo claim is narrowed to what was measured; spike-A numbers are **not** substituted.

## 12. Step 4/5 additions (owner decision, 2026-09-20)
- **Independent-stream dropout mid-hold** (fails closed): (a) gate + fake evidence source, (b) real WebSocket close via a mock server through the real client, (c) once against the real API with a forced disconnect (`scripts/live-dropout.ts`), plus (d) silent stall (speech in flight, stream sends nothing). Assertions: verdict is HOLD `UNVALIDATABLE` within a small bound (**not** the 4 s timeout for a hard drop), the order hash is unchanged, no commit, no hang.
- **Local speech-activity check measured directly** on the exact PCM bytes streamed in the spike-A captures (`scripts/measure-local-vad.ts`): onset lag, lead over the independent stream's `SpeechStarted`, coverage at every `tool.call`. Results in `docs/local-vad-measurement.md`; the earlier "would have flagged 11/11" claim was an inference from send timing and is replaced by this measurement (still on synthetic audio: see §11).

## 13. Step 5 test inventory (2026-09-20)
| Suite | What it proves | Size |
|---|---|---|
| `reliability/test/extractor.test.ts` | deterministic evidence extraction (quantities, homophone ambiguity, corrections, negation, modifiers, pickup, confidence) | 55 |
| `reliability/test/gate-table.test.ts` | verdict table, business outcomes (HOLD => `orders` byte-identical; ALLOW => exactly the spoken change + one audit row) | 70 rows |
| `reliability/test/gate-fuzz.test.ts` | 600 seeded scenarios vs an independent oracle: soundness, fail-closed, completeness; mutation-checked | 3 |
| `reliability/test/dropout.test.ts`, `stt/test/dropout-wire.test.ts` | independent-stream dropout/stall/no-hang, deterministic clock, real clock, real WebSocket | 12 |
| `scripts/live-dropout.ts` (real API) | mid-hold sever => HOLD 38 ms later; before => 1 ms; healthy control => waits 2.4 s, HELD QTY_MISMATCH | 3 scenarios |
| `reliability/test/gate-replay-real.test.ts` | evidence-tier replay of the 21 real spike-A captures through the real gate | 7 |
| `reliability/test/gate-scenarios.test.ts` | scenario B at spike timings, read-back lies, spoken drift, confirm-time reconciliation | 21 |
| `agent/test/gated-handler.test.ts` | wire-level: HELD instruction reaches the agent, order untouched, NOOP, misuse => ERROR | 5 |
| `reliability/test/vad.test.ts`, `evidence.test.ts` | local speech check, evidence tracker state machine | 24 |

Commands: `npm test`, `npm run live:dropout` (needs key), `npm run measure:vad`.
**All Step 5 evidence is synthetic speech; the real-speech pass (§11) is still required before demo lock.**


## 14. Step 4 test inventory (2026-09-20)
| Suite | What it proves | Size |
|---|---|---|
| `reliability/test/ingest.test.ts` | persistence with provenance, supersession, instability, idempotency, error containment, real-capture ingestion, server-timestamp ordering on 3 capture sets | 13 |
| `reliability/test/bargein.test.ts` | derived barge-in, synthetic + the real captures (2 real interruptions, 0 false positives across 45 others) | 12 |
| `reliability/test/recorder.test.ts` | byte-exact PCM recording, sha256, no overwrite, crash-safety | 7 |
| `agent/test/wire-events.test.ts` | server timestamps, audible-reply detection, captured-log compatibility | 7 |
| `reliability/test/gate-content.test.ts` | content-vs-intent over the whole menu (63 pairs x 3 modes, 132 item pairs, 81 quantities, all tools, phrase precision) | 13 |
| `server/test/runtime.e2e.test.ts` | the composition root end to end (mock Voice Agent + mock streaming STT, real SQLite/recorder/VAD/gate/clock) | 10 |
| `server/test/app.test.ts` | auth, token hygiene, SSE, WS mic bridge limits, startup refusals | 18 |
| `reliability/test/real-speech-lib.test.ts` | WAV loading, intent comparison, the FIXED pass criteria | 16 |
Mutation checks run for the gate (stream status, quantity, in-flight wait) and for content (unrequested modifiers, omitted modifiers, item identity): each mutation is caught. Total after Step 4: **431 tests, 30 files**.


## 15. Step 6 test inventory (2026-09-20)
| Suite | What it proves | Size |
|---|---|---|
| `reliability/test/repair.test.ts` | scenario B HELD -> repair -> confirmed -> ALLOWED with unrelated lines byte-identical; resolution only by re-validation (yes alone is not enough; NOOP repeat resolves); per-item attempt counter; escalation after 2 (nothing committed, other item allowed, no extra rows); late valid call after escalation; new dispute restarts; idempotent replay; agent misuse asks nothing; confirm_order scope; ITEM_MISMATCH alt-scope; configurable limit; pending stays pending at hangup; no text names another item (12 items x 16 codes); escalation is not a question | 13 |
| `agent/test/repair-adapter.test.ts` | normal HELD instruction vs escalated instruction (do not re-ask, do not re-call that item, continue the rest) | 2 |
Mutation checks: no resolve-on-commit -> 4 fail; no escalation -> 3 fail; misuse holds asking the customer -> 1 fails. Total after Step 6: **446 tests, 32 files**.
**Not covered by any automated test (by design, see D-27):** the real agent's behaviour on a HELD/escalated result, and barge-in over the agent during a repair. Both need the live-mic session (Step 11).


## 16. Step 7 and the spoken-string audit (2026-09-20)
| Suite | What it proves | Size |
|---|---|---|
| `reliability/test/cases.test.ts` | case snapshot contents; created with the repair record; skipped-and-audited without audio/events and in replay sessions; every case has an existing recording and stored events; immutability; idempotency; atomic rollback; tagger flips exactly on the 3rd, different patterns do not collide, threshold configurable; pattern derivation; expected state only from resolved repairs; escalated cases have none; agent-misuse cases; hangup marks open disputes pending; acceptance rules and audit | 17 |
| `server/test/cases-api.test.ts` | token required; list/detail/counters; counters flip on the 3rd; accept refused (409) until resolved; no order write | 3 |
| `server/test/runtime.e2e.test.ts` (+1) | real runtime: stale call -> case with the real recording, stored evidence, `case`/`repair` events, expected state on resolution, hangup marks leftovers pending | 1 |
| `reliability/test/spoken-audit.test.ts`, `agent/test/repair-adapter.test.ts` | D-28 audit: 18,000+ template renders, real gate evidence values, agent-facing results | 12 |
Mutation checks (Step 7): threshold off-by-one -> 3 fail; no expected-state write -> 3; no hangup marking -> 1; resolved-only acceptance removed -> 2.


## 17. Step 8 test inventory (2026-09-20)
| Suite | What it proves | Size |
|---|---|---|
| `reliability/test/replay.test.ts` | known-fixed case PASSES at the spike-A timing (including events that arrived during the wait); 3 runs byte-identical (`diff_json`, verdict, stored rows); live state untouched; broken build FAILS with `SAFETY_REGRESSION`; missing-evidence holds keep holding; no-expected-state cases; desiredOutcome; error/guard cases (`seedReplayOrder` refuses non-replay sessions); wording (`describeReplay`, never "deterministic" for audio); `judgeAudioRun` canonical compare | 13 |
| `server/test/replay-audio.test.ts` | audio tier through fresh sessions on mock servers: 3/3 passed with 1x pacing (>= 3 x clip), distinct replay-mode sessions, no cases spawned, live order untouched; 2/3 = FAIL; no-tool-call and start failure recorded as FAIL; refuses no-expected-state / unknown case / bad k; API: token, evidence sync, audio 202 + polling, 409 on concurrent run, labels | 7 |
Mutation checks: late events dropped -> 2 fail; hold-check removed -> 2; evidence events dropped -> 3; audio judge always-pass -> 3; "majority passes" instead of "all pass" -> 2.
**Not covered:** the audio tier against the REAL managed agent (needs a real resolved case; live-mic session).


## 18. Step 9 test inventory (2026-09-20)
| Suite | What it proves | Size |
|---|---|---|
| `reliability/test/promotion.test.ts` | registry immutability (recreate, UPDATE, DELETE), input validation, baseline once, integrity/hash check; passing config promotes; a config that breaks a previously-passing case is BLOCKED and names it; one failing case among several blocks and only it is named; no/other/used/STALE suite run refused; only regression-tagged cases run; empty suite vacuous; prompt change requires audio (pass / 2-of-3 / error); gating-only change does not; rollback rules; validation notice on every report; compare table | 15 |
| `server/test/promotion-api.test.ts` | auth on every route; tool schema always the contract's; duplicates 409; run-suite -> promote flow; blocked promotion names the case and carries the notice; audio suite as an async job (no live agent => 0/3, named); rollback; compare; `startServer` bootstraps baseline v1 once | 8 |
Mutation checks: status check removed -> 1 fails; staleness check removed -> 1; single-use check removed -> 1; audio-required rule removed -> 1.
**Not covered:** a real promotion with real-speech cases and the live agent (validation status, D-31).


## 19. Step 10 test inventory (2026-09-20)
| Suite | What it proves | Size |
|---|---|---|
| `reliability/test/drift-repair.test.ts` | quantity / total / not-on-order drift -> scoped repair stating the TRUE value, recorded as claim + repair + case, order untouched; nothing raised for right statements, questions, offers; guards (order changed mid-reply, interrupted, duplicate utterance); resolution only by a correct later statement (silence and wrong restatements do not); 2 corrections then ONE hand-off then silence; hold and drift accounting independent on the same item; unresolved drift at hangup; deterministic drift-case replay, broken check FAILS | 13 |
| `server/test/step10.e2e.test.ts` | real runtime, REAL fixture audio: scenario B end to end (items_json burger x3, total 2697, paired unbroken audit chain), agent mis-states quantity and total aloud -> two `reply.create` corrections (queued behind replies), both resolved, wire message types exactly session.update/input.audio/tool.result/reply.create; unfixable drift -> 2 corrections + 1 hand-off, no loop, order untouched | 2 |
| `agent/test/drift-instruction.test.ts` | wire wording (true value, nothing changed, no tool call, no ids), escalated variant, totals recomputed from lines | 4 |
Mutation checks: order-version guard removed -> 1 fails; escalation stop removed -> 1; hold/drift separation removed -> 3; correct-statement requirement removed -> 1.
**Not covered:** the real managed agent's response to `reply.create` corrections (live-mic session).


## 20. Steps 11-15 test inventory (2026-09-21)
| Suite | What it proves |
|---|---|
| `reliability/test/metrics.test.ts` | percentiles; every stage from a scripted timeline with known latencies; counts/rates recomputed from rows; wrong intent lowers accuracy; false positives; slow commit |
| `dashboard/test/state.test.ts` | reducer over REAL captured event streams (A, B, dropout, confidence); purity; timeline geometry, tooltips, escaping |
| `dashboard/test/ui.test.ts` | the mounted UI with an in-memory server: sign-in/401, WAITING chip mid-stream, badge sequence, REPAIR line, barge-in marker, order panel, counters, cases/replay/diff viewer, compare table, blocked promotion naming the case, mic toggle, hostile text inert |
| `dashboard/test/e2e.test.ts` | the same UI over REAL HTTP + SSE against the real server and pipeline (scenario B end to end incl. the case and a deterministic replay; dropout) |
| `dashboard/test/misc.test.ts`, `surfaces.test.ts` | WCAG AA contrast of every status pair; colour never the only signal; escaping; no raw ids or agent-chosen strings on operator surfaces; mic resampler/framer |
| `server/test/dashboard-api.test.ts` | static hosting + strict CSP, metrics, stored sessions, SSE backlog, agent audio to the mic socket, case WAV, demo over HTTP |
| `server/test/demo.test.ts`, `demo-seed.test.ts` | clips pinned; A/B/confidence/dropout byte-identical across two fresh runs; D and C; the real seed script leaves a blocking regression |
| `reliability/test/adversarial.test.ts` | 88/88 lies caught, 0/15 clean calls held; a broken build fails the harness; the catalogue matches the corpus |
| `server/test/adversarial-api.test.ts` | 700 seeded hostile requests: no 5xx, no leaks, registry untouched; 413/400 handling |
| `server/test/privacy.test.ts` | PII scan, schema, bundle secrets, no browser path to the vendor, no log leak, ignore files, no server path in any API response |
**Not automated:** a real browser and a real microphone; the real-speech pass; the live agent beyond `scripts/live-repair-session.ts` (run by hand, results in `docs/live-repair-validation.md`).

## Current total (2026-09-21)
**637 tests, 58 files**, all passing; `tsc --noEmit`, `check:boundaries` and `scan:secrets` clean. Added this round: origin policy (4, mutation-proven, sends a real Origin header), eviction (2), .env.example consistency (3), smoke-deployed (6). Per-step totals above are historical.
