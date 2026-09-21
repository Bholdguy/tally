# Tally — Product Contract (Step 1)

Defines what a **critical fact** is, what a **valid tool call** is, and what counts as a **conflict**. Machine-readable source of truth: `/contract/src` (zod). This document and the code must agree; `contract/test` enforces the parts that can be checked mechanically. Loop stages served: EXTRACT (facts), VALIDATE (verdict rules), REPAIR (templates).

## 1. Critical facts (entity types)
`item`, `quantity`, `modifier`, `removal`, `substitution`, `total`, `pickup_time`. Every entity records its source utterance and `audio_offset_ms` (provenance, rule 2).
Modifier classes: `no_*` → **removal**; `sub_*` → **substitution**; everything else → **modifier**.

## 2. Seed menu and modifier vocabulary
Source: `contract/src/menu.ts` (PRD §B.4). 12 items; prices in integer cents; price deltas: `extra_cheese` +100, `add_bacon` +150, `add_cheese` +75, `gluten_free_bun` +100, `size_large` +75, `sub_chicken_for_beef` +100. Milkshake requires exactly one `flavor_*`. `cheeseburger` does not offer `extra_cheese`.
Total = Σ (base + modifier deltas) × quantity. No tax (no payment processing).

## 3. Tools

| Tool | Args (canonical) | Mutates | Mode | Notes |
|---|---|---|---|---|
| `add_item` | `item_id`, `quantity` int 1–20, `modifiers[]` ⊂ item vocabulary | yes | hold | milkshake: exactly one flavor |
| `remove_item` | `item_id` | yes | hold | |
| `update_quantity` | `item_id`, `quantity` int 1–20 | yes | hold | 0 is invalid; use `remove_item` |
| `apply_modifier` | `item_id`, `modifier` ∈ item vocabulary | yes | hold | |
| `confirm_order` | `order_id`, `pickup_time` = `"ASAP"` or ISO-8601 with offset | yes | hold | `pickup_time` added to the brief's signature (D-10) |
| `get_order_state` | `order_id` | no | interactive | logged, not gated |

All argument objects are **strict**: unknown properties are rejected. The model never sees or supplies `order_id`; Plane 1 injects it (a model-supplied `order_id` is ignored). Declarations sent to the model come from `toolDeclarations()`.

## 4. Evidence
Evidence = finalised user utterances (`transcript_user`) plus turn/VAD state. Never the agent's words (rule 3). Extraction rules (Step 4): number words/digits/homophones, menu aliases, correction cues (`no wait`, `actually`, `make that`, `scratch that`, `I mean`, `cancel`, `instead of`), last-mention-wins after a cue, negation scope for `no_*`. Ambiguity (e.g. `for`/`four`) is flagged and never resolved silently.
Confidence proxy: text instability (partial-vs-final divergence, delta churn), since the API provides no confidence (D-03).

## 5. Conflict taxonomy
| Code | Meaning |
|---|---|
| `QTY_MISMATCH` | args quantity ≠ evidenced quantity |
| `ITEM_MISMATCH` | args item ≠ evidenced item |
| `MODIFIER_MISMATCH` | args modifiers ≠ evidenced modifiers |
| `REMOVAL_MISMATCH` | removal (`remove_item`/`no_*`) not evidenced or evidenced but absent |
| `SUBSTITUTION_MISMATCH` | `sub_*` not evidenced or wrong |
| `STALE_EVIDENCE` | a later utterance supersedes what the call relied on |
| `UNSUPPORTED_CLAIM` | no utterance supports the call |
| `SPOKEN_STATE_DRIFT` | agent's spoken item/qty/total ≠ committed state |
| `TOOL_RESULT_LIE` | handler-returned result ≠ independently re-read state |
| `TOTAL_MISMATCH` | reported/spoken total ≠ recomputed total |
| `SCHEMA_INVALID` / `UNKNOWN_ITEM` / `BAD_MODIFIER` | args violate this contract |
| `PICKUP_TIME_MISMATCH` | pickup time differs from evidence |
| `PENDING_EVIDENCE` | user speech in flight / evidence unsettled |
| `UNVALIDATABLE` | anything Tally cannot validate. **Fail-closed default.** |

## 6. Verdict rules (fail closed)
`ALLOW` iff **all** hold: schema valid; the independent evidence stream is up and not stalled; the customer is not mid-speech (the gate waits, bounded, and HOLDs on expiry); every argument (item, quantity, options, pickup time) is supported by the deterministic extractor's reading of the customer's finalised speech, with the LAST mention winning after a correction; every quantity/item word meets `MIN_WORD_CONFIDENCE` and none is a homophone reading (to/too/for); the projected state diff equals the args; `confirm_order` also requires the whole order to equal the evidence (D-22). Otherwise `HOLD` with a code. There is **no** path that returns ALLOW on exception, timeout, missing event or unknown state (rule 1). (The stored text-instability score, D-03, is recorded but is NOT a gate condition.) Detail: ARCHITECTURE §5b.

## 7. Repair protocol
Tally emits `RepairInstruction` (data only; Plane 1 speaks — D-09). Text from `REPAIR_TEMPLATES`, scoped to the disputed item, e.g. `Just to confirm, that's 3 classic burgers?`. At most `MAX_REPAIR_ATTEMPTS` (2) scoped asks per item, then `escalated` (a hand-off); the rest of the order is never touched. `resolved` is written only when a call re-passes every gate check. Spoken-drift repairs (Step 10) are counted separately. The spoken *wording* of every value goes through `contract/src/spoken.ts` (D-28).

## 8. Event envelope
`TallyEvent` (`contract/src/events.ts`). Agent stream: `session_started`, `input_speech_started/stopped`, `transcript_user_delta`, `transcript_user`, `reply_started`, `reply_audible` (first non-silent audio, D-18), `transcript_agent`, `reply_done`, `tool_call`. Independent evidence (D-04): `evidence_transcript` (per-word confidence), `evidence_speech_started`, `evidence_stream_status`, `local_vad`. Derived: `barge_in` (exactly two source event ids: D-02). Tally outputs (never from a wire; excluded from replay snapshots): `gate_waiting`, `verdict`, `order`, `repair`, `case`. Housekeeping: `parse_warning`, `session_error`, `session_ended`. Every event carries `t_ms`, `wall_ms`, `audio_offset_ms` and, for agent events, the server's own `server_ts_ms` (D-05). Agent-stream transcripts carry no confidence; `evidence_transcript` words do.

## 9. Sample payloads
Valid: `{"item_id":"burger","quantity":2,"modifiers":[]}` · `{"item_id":"burger","modifier":"no_pickles"}` · `{"order_id":"o1","pickup_time":"2026-09-19T18:30:00-04:00"}`.
Invalid: `quantity:0`; `item_id:"pizza"`; `modifier:"extra_cheese"` on `fries`; milkshake with no flavor; `pickup_time:"soon"`; extra properties. The full set is exercised in `contract/test/contract.test.ts`; one example per conflict code is in `contract/test/conflict-fixtures.ts`.
