# Rehearsal script: demo on Render's free tier

Service: https://tally-1wnr.onrender.com (free web service, **no persistent disk**, single instance). Written for whoever runs the demo, the real-speech pass follow-up and the human microphone session. Sequence facts below come from `render.yaml`, `scripts/render-start.sh` and the Render boot log from 2026-09-22.

## What the platform does to you
| Event | What happens | Consequence |
|---|---|---|
| 15 min without inbound traffic | Render spins the instance down | next request wakes it |
| Wake / restart / redeploy | container starts empty → `render-start.sh` runs `demo:seed -- --fresh` (~75-90 s) → server starts | **~2 min** before the dashboard answers; the first browser request may just hang or show Render's "waking up" page |
| Any of the above | in-memory sessions and the whole database are gone | a call in progress is dropped (no reconnect); every case a visitor created is lost; the seeded data returns |
| An active call or open dashboard tab | traffic keeps it awake | a 10-minute pause with no requests is fine; 15 is not |

Nothing is persisted between wakes: **anything you want to keep from a session (screenshots, the case ids, the numbers on the Metrics tab) must be written down before you stop.**

## T-20 min: wake it and verify the seed
1. Wake it: open https://tally-1wnr.onrender.com/healthz in a browser (or `curl -m 180 https://tally-1wnr.onrender.com/healthz`). Expect `{"ok":true}` after up to ~2 min. If it has not answered after 4 min, open Render → the service → Logs.
2. Logs, in order (the exact wording is in `scripts/demo-seed.ts`): `[render-start] reseeding demo data (--fresh)` → scenario steps → `operator accepted case ... as a regression` → `suite for v2: BLOCKED ...` → `suite for v3: PASSED 1/1 ...` → `ready: 7 cases, 5 candidates, 1 regression(s); active config v1` → server listening. **`[render-start] WARNING: demo seed FAILED` means the data is partial: redeploy (Manual Deploy → Deploy latest commit) and re-check.** Do not demo on a partial seed.
3. Open the dashboard, sign in with the operator token (typed into the page; it is never in a URL).
4. Confirm from the screen, not the logs: counters **7 cases, 5 candidates, 1 regression**; Lab: **v1 active, v2 BLOCKED (names the accepted case), v3 PASSED**. The DETERMINISTIC-DEMO banner appears when a scenario plays.
5. Keep it awake: leave the dashboard tab open (its requests count), or `curl /healthz` every ~10 min from your machine. Do not rely on a tab in a background browser that suspends timers.

## Rehearsal run (do this once end to end, 20 min)
Follow DEMO.md's 16 beats with these deployment-specific adjustments. (`DEMO.md` is kept local-only on the maintainer's machine, not tracked in this repo — if you don't have it, ask the maintainer for a copy.)
- **Beat 1:** counters are 7 / 5 / 1 (not "6+").
- **Beat 12:** D was already played by the seed, so playing it adds three more cases; either skip it or say so. Never claim "two more".
- **Beat 13:** accepting another candidate makes Regressions 2; that is fine, but note it changes v2/v3 suite results if you re-run them (a v3 that passed 1/1 must still pass 2/2: check before the real demo, on a database you are willing to lose).
- **Beat 14:** promote v3, then **Roll back to v1** so the next viewer sees the state you started from. A restart also resets it.
- Time each scenario on this host; deterministic scenarios run in real time (roughly 15-60 s each), the audio-tier replay is about 3x the clip.
- After the run: does anything you did need to survive? If yes, record it now.

## Cold-start plan during a live demo
- **Before the audience arrives:** wake and verify (above); never start from a sleeping service.
- **If it restarts mid-demo** (deploy, platform restart, idle): tell the audience plainly what happened: *"The free tier just restarted the process; it reseeds itself. Everything you saw was stored in a database that reset."* Then wait ~2 min for `/healthz`, sign in again, re-verify 7 / 5 / 1, continue from beat 1 or the last beat that does not depend on prior state. Do not improvise numbers.
- **If the wake stalls (>4 min or the WARNING line):** switch to the local run (`npm run serve`, same DEMO.md beats — local-only file, not in this repo — http://127.0.0.1:8787) rather than debug on stage. Keep the local `.env` ready and the token at hand.
- Say the limitation (README #16) if asked: no persistent disk, reseeds on boot, cold start after 15 idle minutes; the reliability layer's persistence is proven in the test suite against a real database.

## Where the two owner validations run
- **Real-speech pass:** runs on a local machine with the tooling (`npm run real-speech:run`, protocol and fixed criteria in `docs/real-speech-validation.md`); it needs the API key locally and does not touch Render. Nothing about the Render cold-start affects it.
- **Human microphone session:** can be run on the deployed URL (HTTPS is required for the browser microphone and Render provides it; the page's own origin is accepted by the mic WebSocket). Do it inside one uninterrupted stretch: a restart drops the call. Speak fake data only. Before closing the tab, copy out what `docs/live-repair-validation.md` asks for (transcripts, held calls, repair questions, final order, case ids), because the database will not survive the next wake. Then fill in that document and the TASKS.md item; the deployment cannot store the result for you.
- Both remain **NOT RUN** until a person does them; nothing here changes their status.

## Pre-demo checklist (copy)
- [ ] `/healthz` returns `{"ok":true}`; woke at least 20 min ago
- [ ] Render logs show the clean seed, no `WARNING`
- [ ] Dashboard: 7 cases, 5 candidates, 1 regression; v1 active; v2 BLOCKED, v3 PASSED
- [ ] Token typed only into the page; a fresh token if the old one was ever displayed
- [ ] A tab open (or a keep-alive ping) so it cannot idle-sleep
- [ ] Local fallback ready (`npm run serve`)
- [ ] Limitations sentence memorised (README #16)
