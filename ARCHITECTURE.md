# Tally — Architecture

Traces to PRD.md Part B and brief §8. Loop: `LISTEN → EXTRACT → VALIDATE → ALLOW or REPAIR → RECORD FAILURE → REPLAY → IMPROVE`.

## 1. Request path

```
Browser mic ──WS /ws/mic──► server (Fastify composition root)                    [no keys in browser]
                               │
                               ▼
                 ┌──────────── PLANE 1 · /agent ────────────┐
                 │ AssemblyAI socket client                  │   wss://agents.assemblyai.com/v1/ws
                 │  · input.audio  ──────────────────────────┼──► AssemblyAI Voice Agent API
                 │  · reply.audio  ◄─────────────────────────┼──  (STT · turn/VAD · LLM · tool calling · TTS)
                 │  · tool.call    ◄─────────────────────────┤
                 │  · tool.result / reply.create  ───────────┼──►   (ONLY Plane 1 sends these)
                 │ RepairAdapter: RepairInstruction → wire   │
                 └───────┬───────────────────▲───────────────┘
        typed TallyEvent │ + input PCM       │ GateResult{verdict, RepairInstruction?}
        (EventSink)      ▼                   │ (gate.submit)
                 ┌──────────── PLANE 2 · /reliability ───────┐
                 │ ingest → events_raw → utterances/vad/     │
                 │          entities (extractor)             │
                 │ gate: schema → settle/buffer → evidence   │
                 │       match → state-diff → verdict        │
                 │   ALLOW ──► committer (sole RW SQLite) ──► orders + audit_events (1 txn)
                 │   HOLD  ──► repair (instruction only) ──► back to Plane 1
                 │ cases · tagger · replay runner · promotion│
                 │ metrics                                   │
                 └───────┬───────────────────────────────────┘
                         │ SSE /api/live/:id · REST /api/*
                         ▼
                 Dashboard (plain TypeScript, served by this server) — reads evidence, cases, metrics via the API
```

### 1b. Independent evidence path (added 2026-09-20, D-04 reversed)
The Step 3 spike showed the Voice Agent's live `transcript.user` stream misses corrections that overlap a hold (7 of 8 late/hold runs; `docs/spike-g5.md`). Tally therefore listens to the customer on its own:

```
input PCM (the same chunks Plane 1 sends to the agent)
   ├─► Voice Agent session (Plane 1)                       → the record of what the AGENT heard / did
   └─► /stt independent STT stream (own connection)        → the record of what the CUSTOMER SAID
          Turn{partial|final, words[].confidence}, SpeechStarted
          └─► EventSink → /reliability (evidence_transcript events; gate judges against THIS)
   + local energy VAD on the same PCM (zero-lag "speech in flight" signal, validated in Step 4)
   + option C (permanent safety net): after the call, reconcile live + independent + stored timeline (post-hoc)
```
The agent stream remains authoritative for what the agent said (`transcript.agent`); it is **never** the evidence for ALLOW (rule 3).

## 2. Implementation split (brief §8) and repo layout

| Brief layer | Directory | Notes |
|---|---|---|
| Frontend | `/dashboard` | Plain TypeScript: a pure reducer over typed events + escaped string views, bundled by esbuild, served by `/server` (D-33; the PRD said Vite + React). Talks only to `/server`. |
| Realtime (AssemblyAI session handler) | `/agent` | Plane 1: socket client, tool declarations, system prompt, `RepairAdapter` |
| Orchestrator (reference agent logic, tool handlers) | `/agent` | Tool handlers hold **no DB handle**; they call `gate.submit()` |
| Reliability/control plane | `/reliability` | Plane 2: ingest, extract, gate, repair, committer, cases, replay, promotion, metrics |
| (+) Independent evidence adapters | `/stt` | *Addition (D-04 reversed, 2026-09-20).* Tally-owned **independent STT stream** on the same input PCM (`wss://streaming.assemblyai.com/v3/ws`, `universal-3-5-pro`) plus a read-only session-timeline fetcher for the option-C safety net. Audio in → transcripts out only. No voice output, no DB, no other plane. Lives outside `/reliability` so `/reliability` keeps zero network code. |
| Storage | `/db` | `schema.sql`, migrations, seed; SQLite (WAL) |
| Demo | `/demo/clips` + `server/src/demo` | Prerecorded synthetic PCM (`demo/clips`, hashes pinned) and the deterministic scenario runner (scripted agent + scripted transcripts through the real pipeline, D-34). |
| (+) Shared contract | `/contract` | zod schemas/types/enums, zero runtime deps beyond zod. *Addition:* lets dashboard and both planes share types without importing each other. |
| (+) Composition root | `/server` | Fastify wiring, SSE, REST, `/ws/mic`. *Addition:* the one place both planes are instantiated. |
| Docs | root | CONTRACT.md, ARCHITECTURE.md, PRD.md, … |

Stack: Node >= 22.9, TypeScript (strict), npm workspaces, Fastify, `ws`, `better-sqlite3`, zod, esbuild (dashboard bundle), `tsx` (runs the TypeScript directly; there is no compiled build), Vitest + jsdom (tests; no Playwright).

## 3. Ground rules mapped to structure (brief §14)

| Rule | Structural enforcement |
|---|---|
| 1 Fail closed | `gate.submit` wraps everything in a total function: any throw/timeout/unknown ⇒ `HOLD UNVALIDATABLE`. Only one code path constructs `verdict:"ALLOW"`. Fuzz test. |
| 2 Provenance | `entities`/`tool_calls` carry `source_utterance_id`, `events_raw` ids, `audio_offset_ms` (NOT NULL). |
| 3 No LLM-as-truth | Extractor is deterministic; `transcript.agent` is parsed only by the drift checker, which can only *raise* conflicts. |
| 4 Versioned configs | `configs` insert-only; trigger rejects UPDATE of prompt/schema columns. |
| 5 Real events | Metrics computed from stored rows; no seed path for `cases`. |
| 6 Secrets server-side | `loadAgentConfig` in `/agent` is the only reader of `ASSEMBLYAI_API_KEY`; the composition root hands `/stt` an injected `Secret`; the browser never contacts AssemblyAI (asserted by tests on the source and the built bundle). |
| 7 Replay = live | Replay feeds the same `EventSink` → same ingest/extract/gate. `mode=replay` is a label, not a branch. |
| 8 Mutation only via gate | `committer` owns the only RW connection (§4.2). |

## 4. Hard boundaries (enforced by `npm run check:boundaries`, part of CI and Step 2/3 DoD)

### 4.1 Tally has no path to voice output
The dependency direction is fixed: `agent → reliability → contract`, `db` read side ← both, `server → all`, `dashboard → contract (types only)`.

`/reliability` and `/contract` **must not**:
1. import `/agent`, `/server`, `/dashboard`, or `/demo`;
2. import `ws`, `undici`, `node:http(s)`, `node:net`, `node:dgram`, or any AssemblyAI SDK;
3. define or reference any output-audio type (`reply.audio`, TTS, PCM-out) or wire message names `reply.create`, `reply.audio`, `tool.result`, `conversation.message`, `session.update`, `input.audio` *senders*.

`/stt` (independent evidence adapters) **must not** import `/agent`, `/reliability`, `/server`, `/dashboard`, `/demo`, `/db` or a database, and must not reference `reply.create`, `reply.audio`, `tool.result`, `conversation.message`, `session.update` or the Voice Agent socket URL. Rules `stt-isolated` and `stt-no-voice-output-reference`; `/reliability` and `/contract` may not import `@tally/stt` (`no-cross-plane-import`). The composition root (`/server`) wires `/stt` output into `/reliability` through the `EventSink`.

What crosses the boundary:
- **In:** `EventSink.push(TallyEvent)`, `AudioSink.append(pcm: Uint8Array)` (input audio for evidence/replay only), `gate.submit(ToolCallRequest)`.
- **Out:** `GateResult` containing a `RepairInstruction` (plain data). Only `/agent`'s `RepairAdapter` turns it into `tool.result` JSON and a `reply.create`. Tally cannot speak; it can only tell Plane 1 what to ask.

The boundary script scans imports and string literals in `/reliability` and `/contract` against the deny-list above and fails the build on any hit. A unit test seeds a violating fixture file and asserts the script catches it.

### 4.2 Single write path
- `db/src/connections.ts` exports `openReadonly()` for everyone; `openCommitter()` is exported only to `reliability/committer` (checked by the boundary script: any other importer fails).
- Commit = one transaction: `UPDATE orders …` + `INSERT audit_events …` with a `validation_event_id`. Triggers `orders_require_validation_ins`/`_upd` abort inserts and updates without it. Triggers on `events_raw`, `audit_events`, `cases.event_snapshot_json` deny UPDATE/DELETE.
- Plane 1 is constructed without any DB object at all.

## 5. Gating flow (the design; §5b is the implemented order)

1. `tool.call` (hold-mode) arrives in Plane 1 → `gate.submit({aai_call_id, tool, args, t})`.
2. **Schema check** (contract).
3. **Settle (evidence-driven, not a fixed buffer).** Evidence = the **independent STT stream** (D-04). If Tally's local VAD or the independent stream's `SpeechStarted` / an un-finalised partial says the customer is speaking (or spoke within a short hangover), hold the tool result until the independent stream **finalises that turn**, bounded by `EVIDENCE_WAIT_MAX_MS`; on expiry ⇒ `HOLD PENDING_EVIDENCE` (fail closed, never allow). If nobody is speaking, evaluate immediately (the independent stream's final for the uncorrected utterance arrived before `tool.call` in every spike-A run, so the common path adds no latency). Sizing comes from spike A (`docs/spike-a.md`); the earlier fixed-buffer idea (`GATE_BUFFER_MS`) is superseded (D-16).
4. **Evidence match**: the deterministic extractor runs over ALL finalised customer utterances of the session from the independent stream (last mention wins after a correction cue); it does not use a window since the last commit.
5. **Projected diff** from a read-only order snapshot; compare with args; recompute total.
6. **Verdict**: `ALLOW` only if all checks pass; else `HOLD(code)`. Any exception ⇒ `HOLD UNVALIDATABLE`.
7. ALLOW → committer (txn) → **read-back** (`get_order_state` via read connection) → compare to handler result (`TOOL_RESULT_LIE`) → return actual result.
8. HOLD → `tool_calls.status=held`, `repair_events` row, case snapshot (Step 7), return `RepairInstruction`.
9. Plane 1 sends `tool.result` (after `reply.done` rules for interactive tools; immediately for hold-mode tools) and, if needed, `reply.create{instructions}`.
10. Later `transcript.agent` is fed to the **spoken-drift checker** against committed state.

## 6. Event model

Plane 1 normalises wire messages into `TallyEvent` (contract) with `t_ms` (monotonic since session start), `wall_ms`, and `audio_offset_ms` (= bytes sent ÷ 48 at 24 kHz PCM16). Unknown fields go to `raw`. Parser is tolerant (D-13); required-field absence produces an `UNVALIDATABLE`-relevant `parse_warning` event rather than a crash.

Derived **barge-in** (D-02): emitted by ingest when `input.speech.started` occurs while a reply is in flight (after `reply.started`, before `reply.done`) and then `reply.done.status==="interrupted"` arrives for that reply. Stored as `vad_events{type:barge_in, derived:true, source_event_ids:[…]}`. If speech-started occurs during a reply but the reply completes normally, no barge-in is recorded (backchannel).

## 7. Replay architecture

| Tier | Input | Path | Verdict language |
|---|---|---|---|
| Evidence | `cases.event_snapshot_json` | `EventSink` → ingest → extract → gate (current build) | **deterministic** PASS/FAIL; byte-identical `diff_json` on rerun |
| Audio | stored PCM at 1× | fresh session `mode=replay` with target config via Plane 1 | "k/3 passed"; **never** called deterministic (managed LLM not seedable) |

## 8. Dashboard data flow

Server exposes SSE `/api/live/:sessionId` of typed `TallyEvent`s: transcripts, VAD, tool calls, and the Tally-output events `gate_waiting`, `verdict`, `order`, `repair`, `case` (a late client first receives the stored backlog). Metrics are served by `GET /api/metrics`, not as events. The dashboard is a pure reducer over that stream plus REST reads; it holds no authority (cannot commit, cannot speak).

## 9. Failure modes and their required behaviour

| Failure | Behaviour |
|---|---|
| AssemblyAI socket drops | **Not handled beyond failing closed**: there is no reconnect and no `session.resume`; the call ends, in-flight held calls stay held, nothing commits. The same holds for the independent evidence stream (its drop makes every call UNVALIDATABLE). Known limitation. |
| Event parse failure | A `parse_warning` event is stored with the raw payload. There is no `evidence_degraded` session flag; evidence comes from the independent stream, so an unparseable agent-stream event cannot cause an ALLOW. |
| Extractor throws | `HOLD UNVALIDATABLE` |
| DB write fails | Rollback; `HOLD UNVALIDATABLE`; audit row attempted separately |
| Gate slow | There is no overall gate timeout. The only wait is the evidence wait, bounded by `EVIDENCE_WAIT_MAX_MS` (4 s; briefly raised to 4.5 s on 2026-09-23, reverted the same day — P5's pass criterion is a fixed ceiling on *observed* wait, so raising the system's own cap can only push observed waits higher, never satisfy that ceiling; see D-26) plus stall detection (`STT_STALL_MS`); extraction, judgement and the commit are synchronous. On expiry the call is HELD (`PENDING_EVIDENCE`/`UNVALIDATABLE`), never ALLOWed. |
| Duplicate `call_id` | second is rejected with prior verdict (idempotent) |

## 5b. Gate as implemented (Step 5)
`Gate.submit`: idempotency check by call id -> gated-tool check -> schema (model `order_id` discarded) -> **evidence settle** (stream must be `up`; wait while speech is unresolved, bounded by `EVIDENCE_WAIT_MAX_MS`; stall/down => `UNVALIDATABLE`) -> extract from the independent stream's finals -> `judgeCall` (`confirm_order` also reconciles the whole order with the evidence, D-22) -> projected diff (`NO_CHANGE` => noop ALLOW, nothing written) -> `mintAllow` (only here) -> committer -> **read-back** vs database (`TOOL_RESULT_LIE`). Every HOLD is recorded (`tool_calls` status `held`/`conflict` + audit row) and never touches `orders`. Plane 1's `createGatedHandler` is the only tool path.


## 5c. Composition root as implemented (Step 4): `server/src/runtime.ts`
One `SessionRuntime` per call, one shared clock, one event path:
```
mic PCM -> rt.sendPcm (serialised, real-time paced)
   -> AgentSession.onInputAudio: recorder.append | independent STT feed | LocalVad.feed -> local_vad events
every event (agent stream, independent stream, local VAD, derived barge-in) -> emit():
   Ingest.push (events_raw, utterances, vad_events, entities, barge-in)  +  EvidenceTracker.ingest  +  observers (SSE)
   transcript_agent -> Gate.onAgentSpeech (spoken-drift, detection only)
Voice Agent tool.call -> createGatedHandler -> Gate.submit -> Store (sole writer) -> tool.result on the wire
```
`start()` connects the independent stream FIRST and rejects if it cannot (fail closed); `end()` closes the agent session, the STT stream and the recorder (sha256 receipt) and stamps `ended_at`. The HTTP layer (`app.ts`) exposes session start/inspect/end, an SSE event stream and the mic WebSocket; it has no route that writes an order.


## 7b. Replay as implemented (Step 8)
Evidence tier: `reliability/src/replay.ts` `replayEvidence(store, caseId)`: temp `mode=replay` DB -> `seedReplayOrder(order_before)` (replay sessions only) -> stored events into `Ingest` + `EvidenceTracker` on a `FakeClock` (late events scheduled at their original time) -> `Gate.submit(recorded call)` -> verdict vs `desiredOutcome` -> `replay_runs` row in the live DB (`stableStringify` diff). Audio tier: `server/src/replay-audio.ts` `runAudioReplay` -> k x (`SessionRuntime.start({mode:'replay'})`, `sendPcm(stored PCM)` at 1x, settle, `end()`, final order from the DB vs `expected_state`) -> one `replay_runs` row per attempt, one `suite_run_id`. HTTP: `POST /api/cases/:id/replay?tier=`, `GET /api/replays/:suite_run_id`, `GET /api/cases/:id/replays`. Schema v5 adds `replay_runs.duration_ms`.


## 5d. Spoken-drift loop as implemented (Step 10)
`transcript_agent` -> `SessionRuntime.checkSpeech` -> `Gate.handleAgentSpeech(session, text, {order_version_at_reply_start, interrupted, utterance_id})` -> drift findings vs the COMMITTED order -> `Store.recordHold(tool='agent_speech', repair, case)` -> data-only `RepairInstruction` -> **Plane 1**: `driftInstruction()` -> `AgentSession.correct()` -> `reply.create{instructions}` (queued while a reply is in flight). Later correct speech -> `Store.resolveDriftRepairs`. `/reliability` never touches the socket; the runtime (composition root) is the only bridge, exactly as for `tool.result`.


## 5e. Dashboard, metrics, demo and adversarial harness as built (Steps 11-15)
`dashboard/src` (plain TS: `state.ts` pure reducer over typed events, `timeline.ts` SVG geometry, `views.ts` escaped string views, `main.ts` mount + one delegated listener, `api.ts` fetch/SSE with the token header, `mic.ts`) is bundled by `scripts/build-dashboard.ts` and served by `server/src/routes-extra.ts`. The runtime now emits Tally-output events for it (`gate_waiting`, `verdict`, `order`, plus `repair`, `case`); replay snapshots exclude them (regenerated by the current build). `reliability/src/metrics.ts` computes every metric from stored rows. `server/src/demo/` runs the deterministic scenarios: scripted Voice Agent + scripted streaming-STT servers on loopback, the real `SessionRuntime` in between, prerecorded clips from `demo/clips`. `reliability/src/adversarial/` is the harness (Bench = real gate/committer on a virtual clock in a throwaway DB; corpus; runner).
