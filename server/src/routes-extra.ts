// Step 11/12/15 routes: the dashboard's static files, metrics, stored sessions, the case audio, and the deterministic demo runner.
// Everything under /api needs the operator token (the hook in app.ts). Static files carry no secrets and are the only unauthenticated
// routes besides /healthz; they are served with a strict CSP so the page can only talk to this origin.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { computeMetrics, runAdversarial, type Store } from '@tally/reliability';
import type { AppOptions } from './app.js';
import { runAll, runScenario, SCENARIOS, SCENARIO_LABELS, DEMO_BANNER, type ScenarioName, type ScenarioResult } from './demo/scenarios.js';
import type { SessionRuntime } from './runtime.js';

const DEFAULT_DIST = join(dirname(fileURLToPath(import.meta.url)), '../../dashboard/dist');
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

interface DemoRun { scenario: string; status: 'running' | 'done' | 'error'; steps: string[]; sessions: string[]; results?: ScenarioResult[]; error?: string; banner: string }

export function registerExtraRoutes(app: FastifyInstance, o: AppOptions, runtimes: Map<string, SessionRuntime>): void {
  const store: Store | undefined = o.cases;

  // ---- static dashboard (no auth: the files contain no secrets; the API they call does)
  const dist = o.dashboardDir ?? DEFAULT_DIST;
  const serve = (file: string) => async (_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown }; header: (k: string, v: string) => unknown; type: (t: string) => unknown; send: (b: unknown) => unknown }) => {
    const p = join(dist, file);
    if (!existsSync(p)) return reply.code(404).send({ error: 'dashboard_not_built', hint: 'run: npm run build:dashboard' });
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
    reply.type(TYPES[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream');
    return reply.send(readFileSync(p));
  };
  app.get('/', serve('index.html'));
  app.get('/index.html', serve('index.html'));
  app.get('/app.js', serve('app.js'));
  app.get('/style.css', serve('style.css'));

  // ---- metrics (Step 12): computed from stored rows on every request
  app.get('/api/metrics', async (_req, reply) => (store ? computeMetrics(store) : reply.code(404).send({ error: 'not_found' })));

  // ---- adversarial harness (Step 14): every seeded lie through the REAL gate (about 7 s); nothing it does touches live data
  app.get('/api/adversarial', async () => runAdversarial());

  // ---- stored sessions (Step 11): the Live view for a call that already happened
  app.get('/api/sessions', async () => ({ sessions: store?.listSessions() ?? [], active: [...runtimes].filter(([, rt]) => !rt.ended).map(([id]) => id) }));
  app.get('/api/sessions/:id/events', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!store || !store.listSessions().some((s) => s.id === id)) return reply.code(404).send({ error: 'not_found' });
    return { session_id: id, events: store.sessionEvents(id), order: store.getOrder(id)?.state ?? null };
  });

  // ---- the case's recording, for an <audio> element (fetched with the token, played from a blob: URL)
  app.get('/api/cases/:id/audio', async (req, reply) => {
    const c = store?.getCase((req.params as { id: string }).id);
    if (!c || !existsSync(c.audio_pointer)) return reply.code(404).send({ error: 'not_found' });
    reply.header('content-type', 'audio/wav');
    return reply.send(pcmToWav(new Uint8Array(readFileSync(c.audio_pointer))));
  });

  // ---- deterministic demo (Step 15): scripted agent + prerecorded audio through the real pipeline
  const runs = new Map<string, DemoRun>();
  app.get('/api/demo/scenarios', async () => ({ scenarios: SCENARIOS.map((s) => ({ name: s, label: SCENARIO_LABELS[s] })), banner: DEMO_BANNER }));
  app.post('/api/demo/:scenario', async (req, reply) => {
    if (!store || !o.demo) return reply.code(404).send({ error: 'demo_not_enabled' });
    const name = (req.params as { scenario: string }).scenario;
    if (name !== 'all' && !(SCENARIOS as readonly string[]).includes(name)) return reply.code(400).send({ error: 'unknown_scenario' });
    if ([...runs.values()].some((r) => r.status === 'running')) return reply.code(409).send({ error: 'demo_already_running' });
    const id = `demo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const run: DemoRun = { scenario: name, status: 'running', steps: [], sessions: [], banner: DEMO_BANNER };
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
