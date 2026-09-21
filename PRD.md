# Tally — Implementation PRD

**Status:** APPROVED and implemented (Steps 0-15). This is the ORIGINAL plan and is not kept in sync: where it disagrees with DECISIONS.md or the code, those win (e.g. React/Playwright, `metrics_samples`, demo mode with a real session, auto-promotion of regressions).
**Source of truth:** `TALLY_BUILD_BRIEF.md` (the "brief") + AssemblyAI official docs verified 2026-09-19 (Part A).
**Working name:** Tally. **Tagline:** *The reliability layer that catches a voice agent lying to itself about what it just heard.*

> Conventions: **(+)** marks something added to the brief's schema/spec. **(Δ)** marks a place where the real API differs from the brief's assumption; each Δ has an entry in the DECISIONS.md that will be generated after approval. Nothing here is "TBD" except items the brief marked "fill in", which are filled in below (§B.4 modifier vocabulary, §B.5 hosting).

---

# Part 0. The mechanism every section traces back to

```
LISTEN → EXTRACT → VALIDATE → ALLOW or REPAIR → RECORD FAILURE → REPLAY → IMPROVE
```

| Loop stage | Component (Plane 2 unless noted) | Steps that build it |
|---|---|---|
| LISTEN | Plane 1 session client + Tally ingestion (event stream, raw-audio recorder) | 3, 4 |
| EXTRACT | Deterministic evidence extractor (entities with provenance) | 1, 4 |
| VALIDATE | Gating engine (claim vs evidence vs real state diff) | 5 |
| ALLOW / REPAIR | Committer (only DB writer) / repair injector | 5, 6, 10 |
| RECORD FAILURE | Case snapshotter + pattern tagger | 7 |
| REPLAY | Replay runner (evidence tier + audio tier) | 8 |
| IMPROVE | Promotion gate, regression suite, compare view | 9 |
| (proof/visibility) | Dashboard, observability, adversarial suite, demo mode, security | 11–15 |

**Scope rule:** a feature that does not serve one of the seven stages is not in the core build. The order agent (Plane 1) exists only to generate realistic tool calls for Plane 2 to judge. It is not the thesis.

---

# Part A. AssemblyAI Voice Agent API: verified capability report

Sources (all official, fetched 2026-09-19): Voice Agent API overview, Events reference, Voice Agent WebSocket spec, Client-side tools, Tools overview, Turn detection & interruptions, Message sequence, Session configuration, Audio format, Session history, Connect-your-own-LLM, Universal-3.5 Pro Streaming API, "Voice Agent API vs streaming" article. Base docs: `https://www.assemblyai.com/docs/voice-agents/voice-agent-api`.

## A.1 What exists exactly as the brief assumes

| Brief assumption | Verified reality |
|---|---|
| Single-connection session | ✅ `wss://agents.assemblyai.com/v1/ws`. STT, turn-taking, LLM, tool calling and TTS in one socket. Server-to-server auth: `Authorization: Bearer <API_KEY>` on upgrade. Browser auth: temp token `?token=` from `GET /v1/token` (one-time). First client message must be `session.update`; server replies `session.ready {session_id}`. |
| Typed JSON-schema tool calls | ✅ `session.tools[] = {type:"function", name, description, parameters:<JSON Schema>, execution_mode:"interactive"\|"hold", timeout_seconds:1–300 (default 120)}`. Server emits `tool.call {call_id, name, arguments:{…object…}}`; client answers `tool.result {call_id, result:<JSON string>}`. |
| VAD / turn events | ✅ `input.speech.started`, `input.speech.stopped`, `transcript.user.delta` (partial), `transcript.user` (final), tunable `input.turn_detection {vad_threshold, min_silence, max_silence, interrupt_response, interruption_delay}` (all mutable mid-session). Semantic turn detection is on by default. |
| Interruption handling | ✅ On genuine barge-in the server emits `reply.done {status:"interrupted"}` and `transcript.agent {interrupted:true}`. Backchannels ("uh-huh") are distinguished from real interruptions by the server. |
| Voice output streaming | ✅ `reply.started`, `reply.audio {data: base64 PCM16}` chunks, `transcript.agent.delta` (word-level with `start_ms`/`end_ms`), `transcript.agent`, `reply.done`. Formats: `audio/pcm` 24 kHz 16-bit mono, `audio/pcmu`, `audio/pcma` (8 kHz). Input must be sent in real time (frames beyond ~1 s audio per 1 s wall-clock are dropped). |
| Repair injection path | ✅ `reply.create {instructions}` (one-shot), `conversation.message {role, content}` (context injection), mutable `system_prompt`. |
| Replayable audio | ✅ partially: see G7. |
| Stored sessions | ✅ `GET /v1/sessions`, `GET /v1/sessions/{id}` → stereo OGG/Opus (user left, agent right), JSON timeline with turns, timestamps and tool calls (name, args, result, error flag). Pre-signed URLs expire quickly: store `session_id`, re-fetch. |
| Model | ✅ Voice Agent API runs Universal-3.5 Pro Realtime STT. Flat **$4.50/hr**. |

## A.2 Gaps and differences (Δ) — must be resolved before building on them

| # | Brief assumption | Reality | Pivot (documented in DECISIONS.md) | Fail-closed impact |
|---|---|---|---|---|
| **G1** | Partial/final transcripts carry a **confidence score** (`utterances.confidence`) | ❌ Voice Agent events `transcript.user.delta`/`transcript.user` carry `text` (+`item_id`) only. No confidence. | `utterances.confidence` becomes **nullable**. Confidence is replaced by *structural* evidence-quality signals Tally can compute itself: delta churn (how much the partial text changed before final), final-vs-last-partial divergence, presence of correction cues, entity ambiguity (e.g., "for/four", "to/two"). A second STT stream for confidence is **deferred until after Step 12 (observability) and is not scoped into any build step**; its schema is deliberately not confirmed now (DECISIONS D-04). Text-instability scoring is the confidence proxy for this build. | Low or unknown evidence quality ⇒ hold, never allow. |
| **G2** | A granular **barge-in event** exists (`vad_events.type=barge_in`) | ❌ There is no `barge_in` event. There are `input.speech.started`, `reply.done{status:interrupted}` and `transcript.agent{interrupted:true}`. | Tally **derives** a barge-in marker: `input.speech.started` while a reply is in flight (between `reply.started` and `reply.done`) AND subsequent `reply.done.status="interrupted"`. `vad_events.type=barge_in` is stored as a **derived** row with `derived=true` and links to both source events. "Barge-in reaction time" = `input.speech.started` → `reply.done(interrupted)` (client-observed). | None; derived from real events. |
| **G3** | Events have server timestamps (provenance to audio timestamp) | ❌ *(per docs)* Most events carry no timestamp. **CORRECTED by the 2026-09-19 spike: every inbound event carries a server `timestamp` (Unix seconds); see D-05.** Only `transcript.agent.delta` has `start_ms/end_ms`; `session.ended` has duration. | Tally stamps every inbound event on receipt with a monotonic clock (`t_ms` since session start) and wall clock. Because Tally also owns the outbound audio stream, it records `audio_offset_ms` (bytes sent ÷ 48 B/ms at 24 kHz PCM16) at receipt time. Provenance = `(event_id, audio_offset_ms)`. | Latencies are *client-observed* (include network); labelled as such on the dashboard. |
| **G4** | Tool-call result callbacks expose the agent's **"claimed result"** separate from the **"actual result"** | ❌ `tool.call` carries only `name` + `arguments`. There is no agent-claimed result. The agent's claim exists only as spoken text (`transcript.agent`). We author `tool.result`. | Redefine the three quantities in `tool_calls`: **claimed** = `arguments` (what the model asserts the customer wants) + the agent's subsequent spoken text; **evidence** = extracted entities from `transcript.user`; **actual** = the DB state diff produced by Tally's committer and re-read via `get_order_state`. `claimed_result_json` stores `{arguments, spoken_text}`. Drift = spoken text vs actual state (rule 3). "Silent tool lie" = a tool implementation whose returned result differs from the independently re-read state diff. | Strengthens: the actual result is Tally-authored, not agent-authored. |
| **G5** | Tally can hold a commit *before* the agent confirms | ⚠️ In default `interactive` mode the agent speaks ("let me check…") and `tool.call` arrives **after `reply.done`**, so a spoken confirmation can precede validation. | **All mutating tools are declared `execution_mode:"hold"`**: the agent is silent until `tool.result`, which auto-triggers its next reply. Tally validates *before* sending `tool.result`; the agent can only narrate what Tally returned. Read-only `get_order_state` uses `interactive`. **Risk:** in hold mode "`transcript.user` flushes after hold ends" and user speech during hold "only adds context". Corrections spoken during a hold might reach Tally late. **Mitigation:** (a) `input.speech.started/stopped` still fire and are treated as *pending-evidence* signals: if user speech is in progress or unfinalised when `tool.call` arrives, Tally holds; (b) the Step 3 spike must capture real hold-mode ordering fixtures and **write an explicit PASS/FAIL (`docs/spike-g5.md`)**; (c) **if the spike shows corrections routinely arriving after `tool.result` would have been sent, a buffer window (`GATE_BUFFER_MS`) is added to the gating logic design *before Step 5 starts*, not after**; (d) fallback: `tool.result` carrying a HELD repair instruction encoded in the result JSON. **Step 5 may not begin without a written spike verdict.** **Spike verdict (2026-09-19): NO-GO. Hold mode keeps the agent silent (D-18) but does not reliably deliver correction evidence (D-19); a buffer window alone is insufficient. Step 5 is blocked pending the owner's decision; see `docs/spike-g5.md` §6.** | Hold mode is what makes fail-closed real. If the spike shows evidence can't be settled, gating returns HELD (not ALLOW). |
| **G6** | Repair = "inject a prompt into Plane 1's next turn" | ✅ but via three specific mechanisms. | **APPROVED reading: Tally supplies repair *instructions only*; Plane 1 does all speaking.** Tally emits a typed `RepairInstruction {call_id, code, item, evidenced_value, ask_text}` value. Only Plane 1's adapter converts it into the `tool.result` payload and `reply.create{instructions}`. **Hard boundary:** `/reliability` has no import path to the AssemblyAI socket, the `ws` client, any audio/TTS type, or `reply.*`/`input.audio` senders (see ARCHITECTURE §4, enforced by a dependency test). Tally has *no direct path to voice output*. | Plane separation is structural. |
| **G7** | "Replay the exact audio against an updated agent build" | ⚠️ Feasible, with constraints. Server does **not** echo user audio; input must be sent at ≤ real time. | Tally records the raw 24 kHz PCM16 it sends (`audio_pointer` → local file; plus `session_id` for AssemblyAI's stereo OGG as secondary). Audio-tier replay opens a fresh session with the candidate config and streams stored PCM at 1× (a 20 s case takes ~20 s; silences may be trimmed only outside speech windows). | Replay uses the same event/evidence format as live (rule 7). |
| **G8** | Deterministic replay verdict (§19) | ⚠️ The managed LLM isn't seedable; audio-tier replay is non-deterministic in phrasing and occasionally in tool arguments. | **Two-tier replay (APPROVED).** *Evidence tier:* stored event stream re-fed to the current gating/extractor code. **The word "deterministic" applies only here.** It is the PASS/FAIL in the compare view and promotion gate. *Audio tier (live audio + managed agent):* verdict on final order state vs. expected state, run k=3, reported as **"3/3 passed"** (or "2/3 passed" = FAIL), **never labelled "deterministic"**. | Never claims determinism it doesn't have. |
| **G9** | STT is "Universal-3 Pro" | Docs now call it **Universal-3.5 Pro (Realtime)**. | Use current name everywhere. | None. |
| **G10** | Event payloads consistent | ⚠️ Docs disagree: Events reference lists `item_id`/`reply_id` on more events and `is_error` on `tool.result`; WebSocket spec omits them. `reply.done` docs show `status` only. Interrupted-turn ordering isn't documented. | Tolerant parser (unknown fields kept in `raw_json`, required fields validated). Step 3 spike records a real fixture set of every event type incl. interrupted turn. Contract tests pin against *captured* fixtures, not docs. Do not depend on `is_error`; encode errors in the `result` JSON. | Unknown shape ⇒ event stored, gating holds if a required field is missing. |
| **G11** | n/a | **HTTP tools** (server-side, AssemblyAI calls our endpoint) and **bring-your-own-LLM** exist. | **Banned.** Both move the write path or tool decision outside the gated client path or leave tool-call interception unspecified. Client-side tools only. Recorded in DECISIONS.md as a rule-8 guard. | Preserves single gated write path. |
| **G12** | n/a | Transcription options exist: `transcription_mode` (`max_accuracy`), `keyterms` (≤100), `transcription_prompt` (≤1750 chars). | Use `max_accuracy` + menu `keyterms` to reduce quantity/item mishears (fewer false positives). | None. |

**Go/no-go from the research:** every capability the design *structurally* needs (single socket, typed tool calls, turn events, interruption signals, hold-mode tools, injectable instructions, recordable audio) exists. The two brief features that don't exist (confidence, native barge-in event) are replaced by derived signals without weakening gating. Verdict: **proceed**, with the Step 3 spike as a hard checkpoint on G5.

---

# Part B. Product definition

## B.1 Users and jobs
| User | Job |
|---|---|
| Counter-business owner/operator (buyer) | "When the bot gets an order wrong, I want to know immediately, have it fixed on the call, and never see the same mistake twice." |
| Reliability engineer/operator (dashboard user) | Watch live calls, inspect conflicts, replay cases, compare builds, promote configs safely. |
| Hackathon judge | See FAIL→REPAIR→PASS live, then see the loop close (REPLAY→IMPROVE). |

## B.2 Non-goals (brief §12 verbatim, enforced)
No payment processing · no multi-location/franchise routing · no delivery/logistics · no self-learning claim without a stored replayable case · no general-purpose chatbot fallback bypassing gating · no accent-model retraining. Added: no HTTP tools, no BYO-LLM (G11).

## B.3 Reference vertical (brief §4, complete)
Single-location counter ordering. **Critical entity types:** `item`, `quantity`, `modifier`, `removal`, `substitution`, `order_total`, `pickup_time`.

### Tools (all six; JSON Schema draft-07 in CONTRACT.md)
| Tool | Args | Mutates? | execution_mode | Gated? |
|---|---|---|---|---|
| `add_item` | `item_id: string(enum menu ids)`, `quantity: int 1–20`, `modifiers: string[]` (each ∈ item's allowed vocabulary) | yes | hold | yes |
| `remove_item` | `item_id` | yes | hold | yes |
| `update_quantity` | `item_id`, `quantity: int 0–20` (0 is rejected, use `remove_item`) | yes | hold | yes |
| `apply_modifier` | `item_id`, `modifier` (∈ vocabulary; `no_*` = removal, `sub_*` = substitution) | yes | hold | yes |
| `confirm_order` | `order_id`, `pickup_time` (ISO-8601 or `ASAP`) **(+ pickup_time is required because brief §4 lists it as a critical entity; brief signature shows only `order_id`)** | yes (status→confirmed) | hold | yes |
| `get_order_state` | `order_id` | no | interactive | logged, not gated |

`order_id` is server-injected by Plane 1's session wrapper (one order per session) so the model can never target another order.

### Substitution semantics
Substitution = `sub_*` modifier (e.g., `sub_chicken_for_beef`) via `apply_modifier`, or remove+add pair evidenced by "instead of". Cross-item substitutions must be expressed as `remove_item` + `add_item`, both validated.

## B.4 Seed menu and exact modifier vocabulary (brief Step 1 "fill in")
Prices in integer cents. 12 items.

| item_id | Name | Price | Spoken aliases (extractor) | Allowed modifiers |
|---|---|---|---|---|
| `burger` | Classic Burger | 899 | burger, hamburger, classic | `no_onions`, `no_pickles`, `no_tomato`, `no_lettuce`, `no_sauce`, `extra_cheese`, `extra_pickles`, `extra_sauce`, `add_bacon`, `gluten_free_bun`, `sub_chicken_for_beef` |
| `cheeseburger` | Cheeseburger | 999 | cheeseburger | same as `burger` minus `extra_cheese` |
| `veggie_burger` | Veggie Burger | 949 | veggie burger, garden burger | `no_onions`, `no_pickles`, `no_tomato`, `no_lettuce`, `no_sauce`, `extra_cheese`, `extra_sauce`, `gluten_free_bun` |
| `chicken_sandwich` | Chicken Sandwich | 999 | chicken sandwich, chicken | `no_pickles`, `no_lettuce`, `no_sauce`, `extra_sauce`, `extra_pickles`, `add_bacon`, `gluten_free_bun`, `spicy` |
| `fries` | French Fries | 349 | fries, chips | `no_salt`, `extra_crispy`, `add_cheese` |
| `onion_rings` | Onion Rings | 449 | onion rings, rings | `no_salt`, `extra_crispy` |
| `side_salad` | Side Salad | 399 | salad | `no_onions`, `no_tomato`, `dressing_ranch`, `dressing_vinaigrette` |
| `coke` | Coke | 249 | coke, cola | `no_ice`, `extra_ice`, `size_large`, `size_small` |
| `diet_coke` | Diet Coke | 249 | diet coke, diet | `no_ice`, `extra_ice`, `size_large`, `size_small` |
| `lemonade` | Lemonade | 299 | lemonade | `no_ice`, `extra_ice`, `size_large`, `size_small` |
| `milkshake` | Milkshake | 549 | shake, milkshake | `flavor_vanilla`, `flavor_chocolate`, `flavor_strawberry` (exactly one required), `no_whip` |
| `cookie` | Cookie | 199 | cookie | `warm` |

Modifier price deltas (cents): `extra_cheese` +100, `add_bacon` +150, `add_cheese` +75, `gluten_free_bun` +100, `size_large` +75, `sub_chicken_for_beef` +100; all others 0. Order total = Σ (base + Σ modifier deltas) × quantity. Tax is out of scope (no payment).
Modifier classes: `no_*` ⇒ **removal** entity; `sub_*` ⇒ **substitution** entity; the rest ⇒ **modifier**.

## B.5 Hosting choice (brief Step 2 "fill in")
**SQLite** (WAL mode, `better-sqlite3`) on the demo laptop. Reasons: single-writer committer maps 1:1 onto rule 8, zero-setup reproducibility for judges, deterministic fixtures. Node >= 22.9 + TypeScript monorepo; Fastify + `ws`; React + Vite dashboard. No cloud host required for the hackathon; a `docker compose up` is provided as an optional reproducibility path. Postgres is deliberately deferred.

## B.6 Two-plane model (brief §5) with enforcement
| | Plane 1 — reference workload (`/agent`) | Plane 2 — Tally (`/reliability`) |
|---|---|---|
| Does | Holds the AssemblyAI socket, streams mic audio, plays TTS, declares tools, forwards every `tool.call` to Plane 2 | Ingests every event, extracts entities, gates, repairs, commits, records cases, replays, promotes |
| May not | Write to `orders`; call HTTP tools; silently retry a failed tool call; fabricate confirmations (system prompt + Tally's spoken-drift check) | **Have any path to voice output** (no socket, no audio types, no `reply.*` senders; instructions only); mutate order state outside the committer; allow an unvalidatable call |
| Enforcement (structural, not by convention) | Plane 1 process has **no DB write handle**; its tool handlers only call `gate.submit()`. `orders` is written by exactly one module (`reliability/committer`) using the only read-write SQLite connection; everything else opens `readonly`. A lint/test asserts no other module imports the write connection. | Committer accepts only a `GateDecision{verdict:"ALLOW", validation_event_id}` object; a commit without a paired `audit_events` row is impossible (same transaction). |

**Ban (brief §5):** *no critical value changes without a paired, logged validation event.* Implemented as: `orders` UPDATE and `audit_events` INSERT in one transaction; DB trigger rejects `orders` updates whose `validation_event_id` is null.

## B.7 The four experiences (A–D) → mechanism
| Exp. | Customer does | System does | Data proof |
|---|---|---|---|
| **A clean** | "Two burgers and a coke." | 2 tool calls; each: extract → match → ALLOW < 1 s gating | 2 `tool_calls.status=allowed`; total = 2×899 + 249 = 2047 |
| **B recover** | "Two burgers… no wait, make it three." | `add_item(burger,2)` arrives but transcript evidence resolves to 3 (correction cue, last-wins) → HELD/CONFLICT `QTY_MISMATCH` → tool.result HELD + narrow repair "Just to confirm, that's three burgers?" → "Yes, three" → `update_quantity(burger,3)` ALLOWED → total updated | `tool_calls` conflict→allowed; `repair_events.outcome=resolved`; 1 `cases` row; final `items_json` qty=3 |
| **C replay** | Operator hits Replay on B's case against config v2 | Evidence tier deterministic; audio tier k=3 | `replay_runs` rows for v1 and v2; compare table |
| **D learn** | Same pattern (correction lands mid-item) recurs 3× | `pattern_key` count ≥3 → `cases.tag=regression`, added to suite, counter increments | 3 real `cases` rows sharing `pattern_key`; suite size +1 |

## B.8 Conflict taxonomy and gating rules (the contract's core)
`conflict_type` enum:

| Code | Meaning | Detected by |
|---|---|---|
| `QTY_MISMATCH` | args.quantity ≠ evidence quantity | extractor vs args |
| `ITEM_MISMATCH` | args.item_id ≠ evidence item | extractor vs args |
| `MODIFIER_MISMATCH` | args modifiers ≠ evidenced modifiers (missing, extra, wrong) | extractor vs args |
| `REMOVAL_MISMATCH` | remove_item / `no_*` not evidenced, or evidenced removal absent | extractor vs args |
| `SUBSTITUTION_MISMATCH` | `sub_*` not evidenced / wrong | extractor vs args |
| `STALE_EVIDENCE` | a later utterance (correction) supersedes the evidence the call relied on | temporal ordering |
| `UNSUPPORTED_CLAIM` | no utterance supports the call (hallucinated add) | provenance search |
| `SPOKEN_STATE_DRIFT` | agent's `transcript.agent` states an item/qty/total ≠ actual post-commit state | spoken-claim extractor vs `get_order_state` |
| `TOOL_RESULT_LIE` | handler-returned result ≠ independently re-read state diff | post-commit read-back |
| `TOTAL_MISMATCH` | reported/spoken total ≠ recomputed total | recompute from menu |
| `SCHEMA_INVALID` / `UNKNOWN_ITEM` / `BAD_MODIFIER` | args violate contract | JSON-schema + menu |
| `PENDING_EVIDENCE` | user speech in progress/unfinalised, or evidence window unsettled | speech/turn state |
| `UNVALIDATABLE` | required event missing/malformed, extractor error, DB error | **fail-closed default** |

**Verdict logic (fail closed):** `ALLOW` iff *all* hold: schema valid; extractor produced a definite entity for every arg from ≥1 finalised `transcript.user`; no later contradicting or correction utterance; no user speech in flight; projected state diff matches args. Anything else ⇒ `HOLD` with a conflict code. There is no code path that returns ALLOW on exception, timeout or unknown.
**Evidence settle window:** on `tool.call`, wait up to `SETTLE_MS` (default 1200, configurable) for pending user speech to finalise; on expiry ⇒ `PENDING_EVIDENCE` HOLD.

**Extractor (no LLM-as-truth, rule 3):** deterministic, rule-based: number words/digits/homophones (`to/too/two`, `for/four`), menu aliases, correction cues (`no wait`, `actually`, `make that`, `scratch that`, `I mean`, `cancel`, `instead of`), last-mention-wins after a cue, negation scope for `no_*`. An LLM may be added only as a *second detector that can raise* conflicts (asymmetric); it can never turn a HOLD into an ALLOW.
**Spoken-drift check:** `transcript.agent` is parsed by the same extractor for `(item, qty, total)` claims and compared to committed state; the agent's words are never evidence for an ALLOW.

## B.9 Repair protocol
1. Gate returns HOLD(conflict). Tally writes `tool_calls.status=held`, `repair_events` row (reason, prompt).
2. Tally returns `tool.result` = `{"status":"HELD","code":"QTY_MISMATCH","instruction":"Do not confirm. Ask only: 'Just to confirm, that's three burgers?'"}` and sends `reply.create{instructions}` if needed.
3. User answers → new `transcript.user` → agent re-issues a tool call (`update_quantity`) → full re-validation → ALLOW → commit. Repair `outcome=resolved` **only** after that re-validation (Step 10). If the customer's answer doesn't resolve it after N=2 repair attempts ⇒ `outcome=escalated` and order remains uncommitted for that item; the rest of the order is untouched ("repair without restarting the order").
4. Repair scope = the disputed item only. Templates parameterised by `(conflict_code, item, evidenced_value)`.

## B.10 Data model (brief §9, all fields + additions)

SQLite types. `id` = TEXT (ULID). Timestamps = INTEGER epoch ms (`ts`) unless noted; `t_ms` = ms since session start (monotonic, G3).

```
sessions(id, started_at, ended_at, agent_config_version,
         (+) aai_session_id, (+) mode[live|demo|replay], (+) audio_pointer)
utterances(id, session_id, speaker[user|agent], text, is_partial, confidence NULLABLE(Δ G1),
           timestamp, (+) t_ms, (+) audio_offset_ms, (+) item_id, (+) reply_id,
           (+) start_ms NULLABLE, (+) end_ms NULLABLE, (+) interrupted NULLABLE, (+) revision_of NULLABLE)
vad_events(id, session_id, type[speech_start|speech_end|barge_in], timestamp,
           (+) t_ms, (+) derived BOOL, (+) source_event_ids JSON)        -- barge_in is derived (Δ G2)
entities(id, session_id, type[item|quantity|modifier|removal|substitution|total|pickup_time]  (+removal,substitution,pickup_time from brief §4),
         value, extracted_at, source_utterance_id,
         (+) item_ref, (+) span_start, (+) span_end, (+) cue, (+) superseded_by NULLABLE)
tool_calls(id, session_id, tool_name, args_json, claimed_result_json, actual_result_json,
           status[allowed|held|conflict], timestamp,
           (+) aai_call_id, (+) conflict_type NULLABLE, (+) evidence_json,
           (+) state_diff_json, (+) validation_event_id, (+) execution_mode,
           (+) t_received_ms, (+) t_verdict_ms, (+) t_commit_ms NULLABLE)
repair_events(id, session_id, tool_call_id, reason, repair_prompt, resolved_at, outcome[resolved|escalated|pending],
              (+) attempt, (+) resolving_tool_call_id NULLABLE)
cases(id, session_id, tool_call_id, audio_pointer, transcript_snapshot, conflict_type, created_at, tag[none|regression_candidate|regression],
      (+) pattern_key, (+) event_snapshot_json, (+) expected_state_json, (+) origin_mode[live|demo])
replay_runs(id, case_id, agent_config_version, result[pass|fail], run_at,
            (+) tier[evidence|audio], (+) attempt_k, (+) actual_state_json, (+) diff_json, (+) suite_run_id)
configs(id, version, prompt_hash, tool_schema_hash, created_at, promoted boolean,
        (+) prompt_text, (+) tool_schema_json, (+) turn_detection_json, (+) gating_params_json, (+) parent_version)
audit_events(id, session_id, actor[plane1|plane2|operator], action, before_state, after_state, timestamp,
             (+) tool_call_id NULLABLE, (+) validation_event_id NULLABLE)
orders(id, session_id, items_json, total, status[open|confirmed|cancelled], updated_at,
       (+) pickup_time NULLABLE, (+) last_validation_event_id)
(+) menu(item_id, name, price_cents, aliases_json, modifiers_json)
(+) metrics_samples(id, session_id, stage[stt|gate|repair|commit|first_audio|barge_in], value_ms, ts)
(+) events_raw(id, session_id, direction[in|out], type, payload_json, t_ms, ts)   -- lossless store; everything above is derivable from it
```
Provenance (rule 2): every `entities` and `tool_calls` row links to `source_utterance_id`/`events_raw` ids with `audio_offset_ms`.
Immutability: `events_raw`, `audit_events`, `cases.event_snapshot_json` are append-only (triggers deny UPDATE/DELETE). `configs` rows never overwritten (rule 4).
`pattern_key` = `hash(conflict_type | tool_name | cue_class | position_in_item)`, e.g., `QTY_MISMATCH|add_item|correction_mid_item`.

## B.11 Backend API and dashboard surface
**Server → dashboard:** SSE `/api/live/:sessionId` streaming typed `TallyEvent`s (transcript, vad, barge_in, tool_call, verdict, repair, commit, case, metric).
**REST:** `POST /api/sessions` (start live), `POST /api/demo/:scenario` (A–D), `GET /api/sessions/:id`, `/api/sessions/:id/events` (renamed; there is no `/timeline`), `GET /api/cases`, `GET /api/cases/:id`, `POST /api/cases/:id/replay?tier=`, `POST /api/suite/run`, `GET /api/configs`, `POST /api/configs` (creates new version), `POST /api/configs/:v/promote` (blocked by gate), `GET /api/metrics`, `GET /api/regressions/count`, `GET /api/orders/:id`. Browser audio: `WS /ws/mic` to *our* server (never directly to AssemblyAI, so no token reaches the client and Tally sees everything).
**Dashboard views:** Live (evidence timeline + call log + order panel + verdict badges + latency chips), Cases, Lab (replay + compare table), Promotion (suite summary), Metrics.
**Evidence timeline (signature):** horizontal strip; lanes: user speech, agent speech, tool calls; markers: speech start/stop, ◆ derived barge-in; colours: green allowed, yellow repaired, red conflict/held, grey pending.

---

# Part C. The 15 build steps

Each step: **Building · Why · User can then · Backend/Frontend · Data/API/UI · Tests · Definition of Done.** Steps keep the brief's numbering and names exactly.

## Step 1 — Lock the product contract
- **Building:** `CONTRACT.md` + machine-readable schemas (Zod → JSON Schema): entities, six tool shapes (§B.3), conflict taxonomy (§B.8), verdict logic, repair protocol, event envelope, modifier vocabulary (§B.4). Plus a **fixture-first extractor spec** with ≥40 labelled utterances.
- **Why:** LISTEN/EXTRACT/VALIDATE are meaningless without a fixed definition of a "critical fact" and a "conflict". Also freezes the API-gap pivots (Part A) into the contract.
- **User can then:** nothing visible; reviewers can read exactly what Tally will and won't allow.
- **Backend/Frontend:** `/reliability/contract` package shared by all modules; no runtime.
- **Data/API/UI:** JSON Schemas for 6 tools (args) + `GateDecision`, `TallyEvent`, `Case`; enums for conflict/verdict; sample payloads (valid + invalid) per tool.
- **Tests:** schema validation against sample payloads (each of 6 tools: ≥2 valid, ≥3 invalid incl. bad modifier, qty 0, unknown item); enum exhaustiveness test (every `conflict_type` has a repair template and a fixture).
- **DoD:** schema reviewed against all six tools ✔; every §B.8 code has ≥1 fixture; modifier vocabulary and prices committed; CONTRACT.md merged. *(Acceptance link: foundation for all §19 items.)*

## Step 2 — Sandbox/backend of record
- **Building:** `schema.sql`, migrations, idempotent `seed.ts` (12-item menu §B.4), the single `committer` connection, immutability triggers, `orders` validation-event trigger.
- **Why:** Ground truth for VALIDATE. Rule 8 needs a physical single write path.
- **User can then:** query menu/orders via `sqlite3` (there is no `GET /api/orders/:id`; orders are visible through the SSE `order` event and `GET /api/sessions/:id`).
- **Backend:** `/db`, `reliability/committer` (only RW handle), read-only connection factory.
- **Data/API:** all tables in §B.10; (no `/api/menu` or `/api/orders/:id` routes were built).
- **Tests:** seed twice ⇒ identical row counts/hash (idempotent); trigger rejects `orders` UPDATE without `validation_event_id`; trigger rejects UPDATE/DELETE on `events_raw`/`audit_events`; import-lint test: no module other than committer imports the RW connection; total computation unit tests (incl. modifier deltas, e.g. 2×(899+100 `extra_cheese`)+249=2247).
- **DoD:** DB queryable, seed present ✔; idempotency test green; write-path lint green.

## Step 3 — Live session
- **Building:** Plane 1 agent: WebSocket client to `wss://agents.assemblyai.com/v1/ws` (server-side Bearer auth), `session.update` with system prompt, greeting, `input.transcription_mode=max_accuracy`, menu `keyterms`, six tools (mutating = `hold`), turn detection defaults; mic bridge (`WS /ws/mic`); `tool.call`→`gate.submit()`→`tool.result` plumbing honouring "send result only after `reply.done`" for interactive tools. **Includes the G5/G10 spike** (first task): capture real fixtures for every event type, hold-mode ordering with a mid-hold user correction, and an interrupted turn.
- **Why:** Produce genuine tool calls (with genuine failure modes) for Plane 2 to judge. Spike de-risks the single biggest assumption (can Tally hold before the agent speaks?).
- **User can then:** place a simple order by voice; hear the agent; see a stub transcript.
- **Backend:** `/agent` (session client, tool declarations, system prompt, Plane-1 wrapper injecting `order_id`); temp step: gate is pass-through **stub only in `mode=spike`, never in live/demo** (removed at Step 5; guarded by a test that fails if the stub is reachable outside spike mode).
- **Data/API/UI:** `sessions`, `events_raw` written; `POST /api/sessions`; minimal mic page. Config v1 registered in `configs`.
- **Tests:** scripted clean-order audio (pre-synthesised PCM fixture) streamed at 1× ⇒ expected tool-call sequence; contract tests replay *captured* real events through the parser (G10); assert `session.ready` before audio, `session.end` on teardown, no keys in client bundle.
- **DoD:** clean order works end-to-end ✔; spike report committed (`docs/spike-g5.md`) with fixtures **and an explicit written PASS/FAIL for hold-mode gating**. **BLOCKING GATE: Step 4 may proceed on fixtures, but Step 5 (gating logic) may not begin until the report exists.** If the spike shows corrections routinely arriving after the point `tool.result` would be sent, the buffer window (`GATE_BUFFER_MS`) is designed into the gating logic and recorded in DECISIONS.md *before Step 5 starts*. *(§19: "completes a clean order on live audio".)*

## Step 4 — Evidence/extraction layer
- **Building:** Ingestion service: every inbound/outbound event → `events_raw`, then normalised into `utterances`, `vad_events` (incl. **derived barge-in**, G2), `entities` (extractor, §B.8) with provenance and `t_ms`/`audio_offset_ms` (G3); raw-audio recorder → `audio_pointer`; evidence-quality signals (delta churn, final-vs-partial divergence; G1). Evidence quality uses text-instability scoring only (second STT stream deferred past Step 12, D-04).
- **Why:** EXTRACT must run *as it happens*, not from a flat post-call transcript; replay (rule 7) needs the exact same format.
- **User can then:** (dashboard stub) see a growing structured event list for a live call.
- **Backend:** `/reliability/ingest`, `/reliability/extract`, audio recorder; pure functions so replay reuses them.
- **Data/API/UI:** `utterances`, `vad_events`, `entities`, `events_raw`; `GET /api/sessions/:id/events`; SSE `/api/live/:id`.
- **Tests:** replay a recorded call ⇒ event completeness (every `tool.call` has ≥1 `transcript.user` and a speech-start/stop pair within its window); extractor golden tests (≥40 utterances: "two burgers no wait three" → qty 3 cue=correction; "for fries" → 4?/ambiguous ⇒ flagged; "no onions" → removal); barge-in derivation test from captured interrupted-turn fixture; failure injection: drop `input.speech.stopped` ⇒ session flagged `PENDING_EVIDENCE`-prone, not crashed.
- **DoD:** every tool call has matching transcript/VAD events ✔; provenance link non-null on 100% of entities; a recorded PCM file exists and its byte length matches sent audio. *(§19: barge-in visible.)*

## Step 5 — Action gating
- **Building:** `gate.submit(toolCall)`: schema check → settle window → evidence match → projected state diff → verdict; on ALLOW hands `GateDecision` to committer; on HOLD returns held result. Post-commit read-back (`TOOL_RESULT_LIE` check) and spoken-drift check on `transcript.agent`. Spike stub removed.
- **Why:** This is VALIDATE + ALLOW-or-HOLD. The heart of the product.
- **User can then:** see a brief "validating" state on ambiguous calls; see a wrong claim held, not committed.
- **Backend:** `/reliability/gate`; committer transaction (order update + audit row + `validation_event_id`).
- **Data/API/UI:** `tool_calls` (status, `evidence_json`, `state_diff_json`, timings); `audit_events`; SSE `verdict` events; UI verdict badges (ALLOWED green / HELD red / VALIDATING grey).
- **Tests (unit, business-outcome):** table of ≥60 synthetic `(transcript, tool_call)` pairs → expected verdict + code; property test "no exception path returns ALLOW" (fuzz: null evidence, malformed args, extractor throw, DB throw ⇒ HOLD `UNVALIDATABLE`); injected mismatched call is held and `orders` row unchanged (asserted by hash before/after).
- **DoD:** deliberately wrong claim held ✔; `orders` unchanged after HOLD ✔; fail-closed fuzz green ✔. *(§19: mismatched result is held & flagged.)*

## Step 6 — Targeted repair
- **Building:** Repair injector + templates per conflict code (§B.9): HELD `tool.result` + scoped `reply.create`; attempt counter; escalation after 2 attempts; re-validation on the re-issued call.
- **Why:** ALLOW-or-REPAIR. Failing the whole call is exactly what the brief forbids.
- **User can then:** hear one clarifying question about only the disputed item; answer it; continue the order.
- **Backend:** `/reliability/repair`, template registry, per-item repair state.
- **Data/API/UI:** `repair_events`; SSE `repair`; timeline yellow segment; call-log line `REPAIR: "…"`.
- **Tests:** scenario B (fixture audio: "two burgers, no wait, make it three") ⇒ HELD → repair → "yes three" → ALLOWED; other items in the order remain untouched (assert `items_json` for unrelated items byte-identical); non-resolving answer ×2 ⇒ `escalated`, item uncommitted; repair prompt never mentions other items (regex on template output).
- **DoD:** repair resolves without restarting the order ✔ *(§19)*.

## Step 7 — Automatic regression/case creation
- **Building:** On every HOLD/CONFLICT, snapshot `{audio_pointer + offsets, transcript, tool call, evidence, resolution, expected_state}` into `cases` in the same transaction as the repair record; compute `pattern_key`; tag `regression_candidate` at count ≥ 3 (`REGRESSION_THRESHOLD`, configurable); promote to `regression` after operator/auto acceptance rule (expected state derived from the *resolved* order state, only when repair outcome=resolved).
- **Why:** RECORD FAILURE → feeds IMPROVE. "No self-learning claim without a stored replayable case."
- **User can then:** watch the case counter and regression counter increment live; browse cases.
- **Backend:** `/reliability/cases`, tagger.
- **Data/API/UI:** `cases`; `GET /api/cases`, `/api/regressions/count`; Cases tab; counters.
- **Tests:** force same pattern ×3 ⇒ tag flips exactly on the 3rd; different patterns don't collide; case creation idempotent per `tool_call_id`; every case has non-null `audio_pointer` whose file exists (no seeded rows).
- **DoD:** three repeats auto-flag ✔ *(§19)*; no case without stored audio+events.

## Step 8 — Operator lab
- **Building:** Replay runner with two tiers (G7/G8). **Evidence tier:** feed `event_snapshot_json` through current ingest→extract→gate code path (same code as live) and compare to `expected_state`. **Audio tier:** new session with target config, stream stored PCM at 1×, verdict on final state, k=3 all-must-pass.
- **Why:** REPLAY. Proves fixes and catches regressions on real evidence.
- **User can then:** press Replay on a case; get PASS/FAIL with diff.
- **Backend:** `/reliability/replay`; replay sessions tagged `mode=replay` (same schema as live, no replay-only logic, rule 7).
- **Data/API/UI:** `replay_runs`; `POST /api/cases/:id/replay?tier=`; Replay button, diff viewer.
- **Tests:** replay a known-fixed case ⇒ PASS; replay against a deliberately broken gating build ⇒ FAIL; evidence-tier run twice ⇒ byte-identical `diff_json` (determinism); audio-tier reports k results and never averages away a fail.
- **DoD:** stored-event (evidence-tier) replay yields a **deterministic** PASS/FAIL against the current contract ✔; audio-tier replay is reported as "k/3 passed" and is never called deterministic. *(§19 as amended below.)*

## Step 9 — Safe promotion and rollback
- **Building:** Promotion gate: `POST /api/suite/run` runs all `regression`-tagged cases (evidence tier mandatory 100%; audio tier k=3 on the case set) for a candidate config version; `promote` only if all pass; `rollback` re-activates the parent version. Configs immutable and versioned (rule 4).
- **Why:** IMPROVE without silent regressions.
- **User can then:** create config v2, run all cases, see a pass/fail summary, promote or be blocked.
- **Backend:** `/reliability/promotion`, config registry (`prompt_hash`, `tool_schema_hash`).
- **Data/API/UI:** `configs`, `replay_runs.suite_run_id`; Promotion view with blocking reason per failing case; Compare table (cases × config versions).
- **Tests:** intentionally regress one case ⇒ promotion blocked, response names the case; a passing config promotes; attempting to overwrite an existing version ⇒ rejected.
- **DoD:** config that breaks a previously-passing case is blocked ✔.

## Step 10 — Close the loop in runtime
- **Building:** Post-repair commit path: repair outcome `resolved` is written **only** after the re-issued call re-validates; total recomputed; spoken-drift check on the agent's follow-up confirmation.
- **Why:** A logged conflict that doesn't fix the order is decoration. Completes ALLOW-or-REPAIR.
- **User can then:** hear the corrected total and see the order panel match what they said.
- **Backend:** committer + repair coupling; no new module.
- **Data/API/UI:** `orders.total` updates; order panel; `audit_events` before/after.
- **Tests:** full scenario B end-to-end via fixture audio: final `items_json` = `[{burger, qty 3}, …]`, `total = 3×899 = 2697` (+ any items); `audit_events` shows paired validation row for every change; agent-spoken total ≠ DB total ⇒ `SPOKEN_STATE_DRIFT`.
- **DoD:** post-repair order state equals what the customer said ✔ *(§19: final order state matches intent)*.

## Step 11 — Operator dashboard
- **Building:** React app: Live view (evidence timeline, call log block per brief §11, order panel, badges), Cases browser, Lab/compare, Promotion, Metrics strip; counters (cases, regressions, accuracy).
- **Why:** Reliability is invisible unless shown; judges see FAIL→REPAIR→PASS→REPLAY→PASS live.
- **User can then:** watch a call, click any tool call for evidence + provenance, jump to cases and replay.
- **Frontend:** **Superseded (D-33):** plain TypeScript, fetch-based SSE client (EventSource cannot set headers), no secrets, static timeline SVG.
- **Data/API/UI:** consumes §B.11 endpoints only.
- **Tests:** component tests on reducer (event stream → timeline state); **Superseded (D-33): jsdom over real HTTP/SSE, no Playwright:** E2E for B and dropout through the UI (assert visible badge sequence, counters, compare table cells); a11y colour contrast check (colour is never the only signal; labels included).
- **DoD:** dashboard updates in real time during a live call ✔ *(§19)*; manual demo run passes.

## Step 12 — Observability
- **Building:** Stage timestamps (`t_received`, `t_verdict`, `t_commit`, first-audio, barge-in) → (**superseded, D-35: computed from stored rows; `metrics_samples` is unused**) p50/p95 computation; brief §10 metrics 1–10 computed from stored rows only.
- **Why:** Fail-closed has a latency price; the operator must see it, and the false-positive rate keeps the gate honest.
- **User can then:** see latency chips per call, aggregate p50/p95, conflict rate, repair success rate, false-positive rate, regression pass rate.
- **Backend:** `/reliability/metrics`.
- **Data/API/UI:** `GET /api/metrics` (D-35; `metrics_samples` unused); Metrics strip.
- **Tests:** inject a deliberately slow tool (sleep 800 ms) ⇒ gating/commit stage p95 rises accordingly; each metric recomputed from raw rows in a test and compared (no hand-typed numbers; rule 5); labelled *client-observed* (G3).
- **DoD:** numbers update per call ✔; every displayed number traces to rows.

## Step 13 — Privacy/security
- **Building:** `.env` handling, server-only API key, temp-token/none-in-browser policy (browser talks to our server), sandbox data only, log redaction, audio file access control, secret-scan in CI, README note.
- **Why:** Rule 6; also judges will grep.
- **User can then:** trust the demo repo is safe to clone/publish.
- **Backend/Frontend:** `.env.example` (no values), config loader that refuses to start without the key and never serialises it; bundle-scan.
- **Data/API/UI:** no PII fields exist; synthetic voices/phrases only.
- **Tests:** secret scan (gitleaks-style regex + exact-key search across repo and built `dashboard/dist`); assert no request from the browser goes to `agents.assemblyai.com`; assert `.env` is git-ignored.
- **DoD:** no keys in client or repo ✔ *(§19)*.

## Step 14 — Adversarial tests
- **Building:** Harness that sends tool calls lying about their effect: wrong qty, wrong item, phantom add, dropped correction, stale evidence, handler that returns success without writing, handler that writes a different qty than returned, spoken total off by a dollar, missing `transcript.user`, malformed JSON, duplicate `call_id`, out-of-order events, dropped VAD events. Documented in `adversarial-cases.md`.
- **Why:** Prove VALIDATE catches lies, not just the happy path.
- **User can then:** run `npm run adversarial` and see 100% caught, with per-case verdicts.
- **Backend:** `/reliability/tests/adversarial` (uses the real gate; no mocks of the gate).
- **Data/API/UI:** results table in dashboard Lab.
- **Tests:** each seeded case has an expected conflict code; suite asserts caught==seeded; any uncaught case fails CI; false-positive corpus (valid calls) asserts 0 wrongly held **on the clean corpus**.
- **DoD:** gating catches 100% of seeded adversarial cases ✔; adversarial-cases.md lists every case with expected code.

## Step 15 — Deterministic demo mode
- **Building:** Pre-recorded (TTS-synthesised, checked-in) PCM clips for A, B, C-setup, D×3, played through the **real** live pipeline (real AssemblyAI session, real gating, real DB) via `POST /api/demo/:scenario`; runner script with a fixed seed DB and fixed clock offsets.
- **Why:** The demo cannot depend on a microphone. But the pipeline must be real so no result is faked: demo audio produces genuine cases (this is what makes Beat D honest).
- **User can then:** run `npm run demo A|B|C|D|all` and get the same outcome each time.
- **Backend/Frontend:** `/demo` (clips + runner); dashboard "Play scenario" buttons.
- **Data/API/UI:** sessions `mode=demo`; cases `origin_mode=demo` (labelled in UI).
- **Tests:** run demo mode twice from a fresh DB ⇒ identical verdict sequences, final `orders`, case tags, counters (compare normalised output); final order state per scenario asserted against expected spoken intent; offline fallback documented (evidence-tier playback if network down, clearly labelled).
- **DoD:** demo runs identically every time ✔; all four experiences end with final order matching intent ✔ *(§19)*.

---

# Part D. Acceptance criteria → steps → proof (brief §19)

| Criterion | Step | Proof artifact |
|---|---|---|
| Clean order, live audio | 3, 5 | live run log + `tool_calls` all allowed |
| Clean order, prerecorded audio | 15 | demo A twice, identical |
| Mid-sentence correction → barge-in visible | 4, 11 | derived `vad_events.barge_in` + timeline marker |
| Mismatched result held not committed | 5 | orders hash unchanged; `status=held` |
| Targeted repair without restart | 6, 10 | other items untouched; `repair_events.resolved` |
| Auto-logged replayable case | 7 | `cases` row with existing audio file |
| 3 repeats → regression candidate | 7, 15 | tag flip on 3rd real case |
| **(Amended)** Stored-event replay against current gating code produces a **deterministic** PASS/FAIL; live-audio-plus-agent replay is reported as "3/3 passed" and is not claimed deterministic | 8 | evidence-tier byte-identical twice; audio tier k results stored |
| Dashboard: timeline, latency, case count live | 11, 12 | jsdom E2E over real HTTP/SSE (D-33) |
| Final order = spoken intent in all 4 experiences | 10, 15 | expected-state assertions |
| No secrets in client/repo | 13 | secret scan output |

---

# Part E. Execution-gate audit (flags before approval)

## E.1 Hackathon criteria
| Criterion | How the PRD earns it | Risk / flag |
|---|---|---|
| **Application of Technology** | Structural use of one-socket events: hold-mode tools, `input.speech.*`, interruption signals, `reply.create`, real audio recording/replay. | ⚠ **F1:** two brief-promised primitives (confidence, barge-in event) don't exist. Pitch must say "derived barge-in from AssemblyAI's interruption events", not claim a native event. |
| **Presentation** | Live timeline; FAIL→REPAIR→PASS; compare table. | ⚠ **F2:** hold mode adds a silent pause; must be < ~1 s or the demo feels laggy. Measure in the spike. |
| **Business Value** | Answers "what happens when it's wrong"; metrics from stored rows. | ⚠ **F3:** false-positive rate must be shown honestly; fail-closed can annoy customers. |
| **Originality** | Layer, not another bot. | ⚠ **F4:** dashboard must lead with Plane 2; Plane 1 UI kept minimal. |

## E.2 "What not to build" (§12): PASS, with notes
No payments/multi-location/delivery/retraining anywhere. HTTP tools and BYO-LLM are explicitly banned (G11). "No self-learning claim without a stored replayable case": PASS, but **F5:** the word "learns" in Beat D is only true as "auto-generates a regression case"; UI/pitch wording must say that. `confirm_order` records a pickup time only; no payment.

## E.3 Technical correctness rules (§14)
| Rule | Verdict | Notes / flags |
|---|---|---|
| 1 Fail closed | ✅ | Fuzz test + `UNVALIDATABLE`/`PENDING_EVIDENCE`. ⚠ **F6:** if the Step 3 spike shows hold-mode can't settle evidence in time, the fallback must still hold; no "allow after timeout" is permitted. |
| 2 Provenance | ✅ | `audio_offset_ms` is client-derived (G3), labelled as such. |
| 3 No LLM-as-truth | ✅ | Deterministic extractor; LLM only allowed to raise conflicts. ⚠ **F7:** the brief's Step 5 phrase "check claimed quantity against last confirmed transcript segment" would be satisfied by an LLM extractor; PRD forbids that. |
| 4 Versioned configs | ✅ | Immutable rows. |
| 5 Real stored events | ⚠ **F8:** brief demo Beat 15 "100% across all runs" must be *computed*, and must show the real number even if < 100%. Prerecorded demo audio goes through the real pipeline and creates real cases; **no seeded case rows** anywhere. |
| 6 Secrets server-side | ✅ | Browser never contacts AssemblyAI. |
| 7 Replay = live format | ✅ | Same code path; replay sessions are ordinary sessions with `mode=replay`. |
| 8 Mutation only via gated path | ✅ | Structural single RW handle + DB triggers. |

## E.4 Other places the brief conflicts with itself or reality
- **F9 (brief §5 vs §6):** "Tally must not control voice output directly" but repair "injects a prompt". Resolved as: Tally returns instructions (`tool.result`, `reply.create`); Plane 1's agent speaks. Still a judgment call: please confirm.
- **F10 (§4 vs §9):** critical entities include removal/substitution/pickup_time but §9's `entities.type` omits them; `menu` table is not in §9; `confirm_order(order_id)` has no `pickup_time`. PRD adds all three (marked +). Please confirm.
- **F11 (§19 "deterministic replay"):** only true at evidence tier (G8). Requires your sign-off on the two-tier definition.
- **F12:** `utterances.confidence` and `vad_events.barge_in` semantics changed (G1/G2).
- **F13:** replay of audio takes real time (G7); "Time-to-replay" metric will therefore include audio duration; reported separately for the two tiers.

---

# Part F. Decisions (RESOLVED — PRD approved)
1. **Hold-mode for all mutating tools: ACCEPTED**, conditional on the Step 3 spike; spike verdict is a blocking gate before Step 5; buffer window added before Step 5 if corrections arrive late (G5).
2. **Two-tier replay: ACCEPTED**; "deterministic" = evidence tier only; audio tier = "k/3 passed" (G8, F11, §19 amended).
3. **Schema additions (`removal`, `substitution`, `pickup_time`, `menu`, `confirm_order.pickup_time`) and voice-output reading: ACCEPTED.** Tally supplies instructions only; hard architectural boundary, no path to voice output (G6, F9, F10).
4. **Second STT stream for confidence: DEFERRED** past Step 12; not scoped; schema not confirmed. Text-instability is the proxy (G1, D-04).
5. **TypeScript monorepo + SQLite: CONFIRMED.** Repo scaffold precedes Step 1 implementation.

Companion documents: ARCHITECTURE.md, SECURITY.md, TESTING.md, DEMO.md, DECISIONS.md, `.env.example`, TASKS.md.
