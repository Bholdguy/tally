#!/usr/bin/env sh
# Render free tier has no persistent disk: rebuild the demo data on EVERY boot, then serve. Same shell and environment for both, so the
# seed and the server share gating parameters. A restart already discarded every in-memory session and the (ephemeral) database, so
# this cannot destroy anything that would have survived. If the seed fails the server still starts (an empty dashboard is better than
# an outage) but the failure is loud in the logs.
echo "[render-start] reseeding demo data (--fresh)"
npm run demo:seed -- --fresh || echo "[render-start] WARNING: demo seed FAILED; starting with whatever data exists"
exec npx tsx server/src/main.ts
