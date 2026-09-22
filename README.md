# Tally — a reliability layer for voice ordering agents

Voice agents say "I've got two burgers" whether or not two burgers are in the order. **Tally checks.** It sits beside an AssemblyAI Voice Agent (a reference ordering workload) and:

`LISTEN → EXTRACT → VALIDATE → ALLOW or REPAIR → RECORD FAILURE → REPLAY → IMPROVE`

- **Independent evidence.** Tally runs its *own* streaming transcription of the customer's audio and never takes the agent's word for what was said.
- **A fail-closed gate.** Every order-changing tool call is validated against that evidence (item, quantity, options, pickup time, whole order at confirmation). No evidence → no commit. The gate waits (visibly, ≤ 4 s) while the customer is still speaking, and holds if the evidence stream dies.
- **Narrow repair.** A disagreement becomes a question scoped to the disputed item; two failed asks become a hand-off. Repairs resolve only through a re-validated commit.
- **Spoken-drift repair.** What the agent *says* about the order is checked against the committed order, and corrected if it is wrong.
- **Every failure becomes a replayable case** (audio + events + verdict). Repeats are tagged; an operator accepts regressions; a new config version can only be promoted if every accepted regression case still passes.
- **Nothing changes an order except the gate** (single write path, enforced in code, by the database, and by a boundary script). The agent's speech is never ground truth. Secrets stay on the server.

## Quick start
```
cp .env.example .env               # set ASSEMBLYAI_API_KEY and TALLY_OPERATOR_TOKEN (>= 16 characters)
npm install
npm test                           # boundaries + unit + integration + adversarial + dashboard (about 2.5 min)
npm run demo:seed -- --fresh       # deterministic demo data (no network needed)
npm run serve                      # dashboard + API at http://127.0.0.1:8787 (loopback only; the mic page's own origin is accepted with no configuration)
npm run smoke:deployed -- <url> <token> --dry   # black-box checks of a RUNNING server (drop --dry to also play the scenarios and compare them with a local run)
```
Other commands: `npm run demo -- A|B|C|D|confidence|dropout|all` (deterministic scenarios), `npm run adversarial` (every seeded lie through the real gate), `npm run replay:case -- <case_id>`, `npm run live:dropout` (real-API fail-closed check), `npx tsx --env-file-if-exists=.env scripts/live-repair-session.ts all` (real agent, synthetic customer), `npm run real-speech:*` (the human-speaker validation pass).

## Where things are
`contract/` shared types, menu, repair wording · `db/` schema and triggers · `reliability/` the gate, evidence, cases, replay, promotion, metrics, adversarial harness (no network, no voice output) · `agent/` the reference agent (Plane 1: the only code that speaks) · `stt/` the independent evidence stream · `server/` composition root, API, demo runner · `dashboard/` the operator UI · `demo/clips` prerecorded synthetic audio.
Design and decisions: `PRD.md`, `ARCHITECTURE.md`, `DECISIONS.md`, `SECURITY.md`, `TESTING.md`, `DEMO.md`, `TASKS.md`, `adversarial-cases.md`.

## Security and privacy
- The AssemblyAI key lives only in the server's environment. The browser talks only to this server (same origin); no credential of any kind reaches it. The operator token is sent as a header, never in a URL.
- The server binds loopback by default and refuses to start without the key and a token (or on a non-loopback host without `TALLY_ALLOW_REMOTE=1`).
- **Sandbox data only.** Menu, orders and voices are synthetic; do not speak real personal data (names, phone numbers, addresses, payment details) into the microphone. Recordings stay under `data/` (git-ignored). `npm run scan:secrets` searches the repo and the built dashboard for the key.

## Honest limitations (please read)
1. **Not validated on real speech.** Everything measured so far used synthetic (SAPI) voices and captured API sessions. The real-speech pass (3+ speakers) is built but has **not been run**; accuracy claims are limited accordingly.
2. **The deterministic demo uses a scripted agent and scripted transcripts.** It exercises the real pipeline; it says nothing about the live managed agent's behaviour.
3. **The live repair loop:** validated once automatically (real agent + real STT, a synthetic customer voice, holds induced by fault injection; small sample), **and twice by a human on a real microphone** (2026-09-23, `docs/live-repair-validation.md` Part 2): correction caught and resolved correctly (Session 1); barge-in derived correctly over the agent's speech, rapid-fire repeated corrections correctly escalated to a hand-off instead of committing a guess, and spoken-drift correction (Step 10) fired and was spoken verbatim (Session 2). All four repair-loop checks (scoped question, re-validated resolution, escalation, barge-in) are now confirmed against real human speech at least once, each on n=1.
4. **The promotion gate is only as strong as its regression suite** (synthetic and captured cases, operator-accepted). A pass means "no known failure regressed".
5. **The extractor is rule-based** (quantities, items, options, pickup time, corrections). Unusual phrasings are missed; a miss fails toward holding (a correct order can be held), never toward a wrong commit. False holds on real speech are unmeasured.
6. **Spoken *questions* are never checked for drift; only statements about the order are.** The drift check skips every sentence that ends in "?", so a repair question that changes a number is not caught (the live run showed the real agent saying "2" where Tally told it to ask about "3"; a stronger instruction fixed it in 3 of 3 later runs, but nothing detects a recurrence). Statements are checked for quantities, "not on the order" and totals only, not options, pickup times or item names, and only the first 4,000 characters of a reply. Drift is detected after the fact: the customer has already heard the wrong words.
7. **Application-level enforcement, with only a partial database backstop, on which config version is active** (D-31): the database allows at most one active version and forbids editing or deleting versions, but nothing in the database requires a passing suite run before the flag flips.
8. Latency is client-observed and dominated by the managed agent (about 2.7 s p50 / 8.4 s p95 end of speech → first audio, measured on synthetic speech); the gate adds a bounded evidence wait (≤ 4 s) only while the customer is speaking.
9. One order line per item; modifiers apply to the whole line.
10. **The dashboard was tested in jsdom, not a real browser** (layout, real audio capture and playback are unverified); the audio-tier replay, and the spoken-drift correction path (`reply.create`), have never been exercised against the real agent (mock and scripted agents only).
11. **No reconnection.** If the agent's socket or the independent evidence stream drops mid-call, the call cannot continue (the gate fails closed; nothing resumes). `session.resume` is not implemented.
12. **One process, in-memory state, no rate limiting.** Live and demo sessions and replay/suite jobs are held in memory (a finished session is evicted 60 s after it ends; its stored data stays); one demo run at a time, one audio-replay job per case, one suite job at a time; a restart loses running jobs (stored data survives). SQLite has a single writer.
13. **Recordings are stored unencrypted on local disk** (`data/`, git-ignored) with no retention or purge command. The AssemblyAI-side deletion option in `.env.example` (`AAI_DELETE_SESSIONS`) is **not implemented**.
14. **Security scope:** one shared operator token (no rotation, no per-user identity), loopback by default, **no TLS in the server** (on Render the platform proxy terminates TLS). A remote deployment needs a TLS-terminating proxy, and browsers only allow microphone capture on HTTPS (or localhost).
15. **Dependencies:** `npm audit` reports 5 issues (1 critical, 1 high) in the dev toolchain only (vitest/vite/esbuild); production dependencies report none. The server runs its TypeScript through `tsx` (a dev dependency); there is no compiled build.
16. **Deployed on Render's free tier with no persistent disk; the app reseeds demo data on every boot and will cold-start after 15 minutes idle. Not representative of the persistence guarantees built into the reliability layer itself, which are proven in the test suite against a real database.** Consequences: any case a visitor creates is lost at the next restart, a restart or idle sleep ends a call in progress (the mic socket drops; there is no reconnect), a wake-up takes about two minutes (reseed ~90 s), and the server cannot tell "demo" from "a judge is on a call" (no detection was built; the restart discards the call regardless of the reseed). The deployment has been checked by `/healthz`, an unauthenticated-API 401, the dashboard loading and the boot log; `smoke:deployed` has not been run against it.
