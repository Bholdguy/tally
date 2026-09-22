// Step 11/12/15 routes: the dashboard's static files, metrics, stored sessions, the case audio, and the deterministic demo runner.
// Everything under /api needs the operator token (the hook in app.ts). Static files carry no secrets and are the only unauthenticated
// routes besides /healthz; they are served with a strict CSP so the page can only talk to this origin.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { computeMetrics, runAdversarial, type Store } from '@tally/reliability';
import type { AppOptions } from './app.js';
import { runAll, runScenario, SCENARIOS, SCENARIO_LABELS, DEMO_BANNER, type ScenarioName, type ScenarioResult } from './demo/scenarios.js';
import type { SessionRuntime } from './runtime.js';

const DEFAULT_DIST = join(dirname(fileURLToPath(import.meta.url)), '../../dashboard/dist');
const DEFAULT_LANDING_DIST = join(dirname(fileURLToPath(import.meta.url)), '../../landing/public');
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

/** PCM16 mono 24 kHz -> a playable WAV (so the browser can play a case's recording without a path ever crossing the API) */
export function pcmToWav(pcm: Uint8Array, rate = 24000): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.byteLength, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([h, Buffer.from(pcm)]);
}

export const SECURITY_HEADERS: Record<string, string> = {
  // the page may load only its own script and style, talk only to its own origin (fetch, SSE, the mic WebSocket), and play blob: audio
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; media-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store',
};

interface DemoRun { scenario: string; status: 'running' | 'done' | 'error'; steps: string[]; sessions: string[]; results?: ScenarioResult[]; error?: string; banner: string; createdAt: number }

export function registerExtraRoutes(app: FastifyInstance, o: AppOptions, runtimes: Map<string, SessionRuntime>, amOperator: (req: FastifyRequest) => boolean): void {
  const store: Store | undefined = o.cases;

  // ---- static files (no auth: neither directory contains a secret; the API they call does). Two separate sites share this server:
  // the marketing page at `/` (landing/public, plain HTML+CSS, no build step, no JS) and the operator dashboard at `/dashboard`
  // (dashboard/dist, built by `npm run build:dashboard`). Moving the dashboard off `/` does not touch any `/api/*` route.
  const dist = o.dashboardDir ?? DEFAULT_DIST;
  const landingDist = o.landingDir ?? DEFAULT_LANDING_DIST;
  const serveFrom = (dir: string, file: string, notBuiltError: { error: string; hint: string }) => async (_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown }; header: (k: string, v: string) => unknown; type: (t: string) => unknown; send: (b: unknown) => unknown }) => {
    const p = join(dir, file);
    if (!existsSync(p)) return reply.code(404).send(notBuiltError);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
    reply.type(TYPES[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream');
    return reply.send(readFileSync(p));
  };
  const dashboardMissing = { error: 'dashboard_not_built', hint: 'run: npm run build:dashboard' };
  const landingMissing = { error: 'landing_not_found', hint: 'landing/public is missing index.html/style.css' };
  app.get('/', serveFrom(landingDist, 'index.html', landingMissing));
  app.get('/index.html', serveFrom(landingDist, 'index.html', landingMissing));
  app.get('/style.css', serveFrom(landingDist, 'style.css', landingMissing));
  app.get('/dashboard', serveFrom(dist, 'index.html', dashboardMissing));
  app.get('/dashboard/index.html', serveFrom(dist, 'index.html', dashboardMissing));
  app.get('/dashboard/app.js', serveFrom(dist, 'app.js', dashboardMissing));
  app.get('/dashboard/style.css', serveFrom(dist, 'style.css', dashboardMissing));

  // ---- metrics (Step 12): computed from stored rows on every request
  app.get('/api/metrics', async (_req, reply) => (store ? computeMetrics(store) : reply.code(404).send({ error: 'not_found' })));

  // ---- adversarial harness (Step 14): every seeded lie through the REAL gate (about 7 s); nothing it does touches live data
  app.get('/api/adversarial', async () => runAdversarial());

  // ---- stored sessions (Step 11): the Live view for a call that already happened
  // D-39: a guest sees only DEMO sessions (synthetic, already reviewed, Step 13) and which of those are active; a LIVE call's
  // existence, transcripts and events are operator-only, exactly like the case that a hold on it would produce.
  app.get('/api/sessions', async (req) => {
    const operator = amOperator(req);
    const sessions = (store?.listSessions() ?? []).filter((s) => operator || s.mode === 'demo');
    const active = [...runtimes].filter(([, rt]) => !rt.ended && (operator || rt.mode === 'demo')).map(([id]) => id);
    return { sessions, active };
  });
  app.get('/api/sessions/:id/events', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const s = store?.listSessions().find((x) => x.id === id);
    if (!s || (s.mode !== 'demo' && !amOperator(req))) return reply.code(404).send({ error: 'not_found' });
    return { session_id: id, events: store!.sessionEvents(id), order: store!.getOrder(id)?.state ?? null };
  });

  // ---- the case's recording, for an <audio> element (fetched with the token, played from a blob: URL)
  app.get('/api/cases/:id/audio', async (req, reply) => {
    const c = store?.getCase((req.params as { id: string }).id);
    if (!c || (c.origin_mode !== 'demo' && !amOperator(req)) || !existsSync(c.audio_pointer)) return reply.code(404).send({ error: 'not_found' });
    reply.header('content-type', 'audio/wav');
    return reply.send(pcmToWav(new Uint8Array(readFileSync(c.audio_pointer))));
  });

  // ---- deterministic demo (Step 15): scripted agent + prerecorded audio through the real pipeline
  // Guest-triggerable (D-39) on purpose, so it needs its OWN abuse guards, not just the operator gate: the scenario name is bounded
  // to the six defined names (or the `all` alias, which just chains them — not a seventh surface); a cooldown between ACCEPTED starts
  // guards against a client hammering the route between runs (the "one run at a time" 409 below only rules out genuine overlap); and
  // finished run records are pruned so this Map cannot grow without bound on a long-lived deployment.
  const runs = new Map<string, DemoRun>();
  let lastAcceptedAt = 0;
  const DEMO_RUN_RETENTION_MS = 30 * 60 * 1000;
  const pruneRuns = () => { const cutoff = Date.now() - DEMO_RUN_RETENTION_MS; for (const [id, r] of runs) if (r.status !== 'running' && r.createdAt < cutoff) runs.delete(id); };
  app.get('/api/demo/scenarios', async () => ({ scenarios: SCENARIOS.map((s) => ({ name: s, label: SCENARIO_LABELS[s] })), banner: DEMO_BANNER }));
  app.post('/api/demo/:scenario', async (req, reply) => {
    if (!store || !o.demo) return reply.code(404).send({ error: 'demo_not_enabled' });
    const name = (req.params as { scenario: string }).scenario;
    if (name !== 'all' && !(SCENARIOS as readonly string[]).includes(name)) return reply.code(400).send({ error: 'unknown_scenario' });
    pruneRuns();
    if ([...runs.values()].some((r) => r.status === 'running')) return reply.code(409).send({ error: 'demo_already_running' });
    const now = Date.now();
    const minIntervalMs = o.demoMinIntervalMs ?? 3000;
    if (now - lastAcceptedAt < minIntervalMs) return reply.code(429).send({ error: 'demo_rate_limited', retry_after_ms: minIntervalMs - (now - lastAcceptedAt) });
    lastAcceptedAt = now;
    const id = `demo_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const run: DemoRun = { scenario: name, status: 'running', steps: [], sessions: [], banner: DEMO_BANNER, createdAt: now };
    runs.set(id, run);
    const opts = {
      store, audioDir: o.demo.audioDir, runtime: o.demo.runtime(),
      onSession: (rt: SessionRuntime) => { runtimes.set(rt.session_id, rt); run.sessions.push(rt.session_id); },
      onStep: (m: string) => run.steps.push(m),
    };
    (name === 'all' ? runAll(opts) : runScenario(name as ScenarioName, opts).then((r) => [r]))
      .then((results) => { run.results = results; run.status = 'done'; })
      .catch((e) => { run.status = 'error'; run.error = e instanceof Error ? e.message : String(e); });
    return reply.code(202).send({ run_id: id, banner: DEMO_BANNER });
  });
  app.get('/api/demo/runs/:id', async (req, reply) => {
    const r = runs.get((req.params as { id: string }).id);
    return r ?? reply.code(404).send({ error: 'not_found' });
  });
}
