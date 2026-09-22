// HTTP / SSE / WebSocket surface of the composition root (SECURITY §3). The dashboard (Step 11) and the mic bridge talk to THIS,
// never to AssemblyAI: no credential of any kind reaches a browser. There is no route that writes an order: the only write path
// is Gate -> committer inside a SessionRuntime (rule 8).
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { WebSocketServer } from 'ws';
import type { TallyEvent } from '@tally/contract';
import { toolDeclarations } from '@tally/contract';
import { ConfigError, describeReplay, replayEvidence, ReplayError, runSuite, SUITE_VALIDATION_NOTICE, type Store, type SuiteReport } from '@tally/reliability';
import { clearSessionCookie, isOperator, parseCookies, SESSION_COOKIE, SessionStore, setSessionCookie, tokenMatches } from './auth.js';
import { runAudioReplay, type AudioReplayReport } from './replay-audio.js';
import type { RuntimeOptions, SessionRuntime } from './runtime.js';
import { registerExtraRoutes } from './routes-extra.js';

export { tokenMatches } from './auth.js'; // re-exported: existing imports of `tokenMatches` from this module keep working

export interface AppOptions {
  operatorToken: string;
  /** Step 7 reads and the operator acceptance: the case store (the same Store the runtimes write through) */
  cases?: Store;
  /** audio-tier replay: seconds of silence after the last byte before the final order is read (default 8000 ms) */
  replaySettleMs?: number;
  /** built dashboard files, served at /dashboard (default: <repo>/dashboard/dist) */
  dashboardDir?: string;
  /** marketing landing page files, served at / (default: <repo>/landing/public; plain HTML+CSS, no build step) */
  landingDir?: string;
  /** deterministic demo runner: where recordings go, and the runtime options (gating of the ACTIVE config) each demo session uses */
  demo?: { audioDir: string; runtime: () => Partial<RuntimeOptions> };
  /** `systemPrompt`/`configVersion`: the config under test (audio-tier replay of a candidate) or the active one (new sessions) */
  startRuntime: (body: { mode?: 'live' | 'demo' | 'replay'; systemPrompt?: string; configVersion?: string }) => Promise<SessionRuntime>;
  /** an EXTRA exact Origin allowed to open the mic socket (split deployments); the page's own origin is always allowed. CORS is not enabled at all */
  allowedOrigin?: string;
  maxFrameBytes?: number;         // default 8 KB (a 20 ms frame is 960 B)
  maxQueuedAudioMs?: number;      // default 5000: a client sending faster than real time is disconnected, not buffered forever
  authTimeoutMs?: number;         // default 5000: first WS frame must authenticate
  /** how long a FINISHED session stays attachable (live SSE) before it is dropped from memory; stored data is unaffected (default 60000) */
  endedGraceMs?: number;
  /** D-39: minimum ms between ACCEPTED `/api/demo/:scenario` starts (default 3000), guarding the public unauthenticated route against spam */
  demoMinIntervalMs?: number;
}

/**
 * The mic socket's Origin policy. A browser always sends the Origin of the page that opens the socket. The dashboard is served BY this
 * server, so its Origin equals the request's Host: same-origin is accepted by default with nothing to configure. `allowed` (DASHBOARD_ORIGIN)
 * adds ONE extra exact origin for a split deployment. Any other Origin (a foreign site, `null`, a malformed value) is refused. No Origin
 * header means a non-browser client, which still has to pass the operator-token check in the first frame.
 */
export function originAllowed(origin: string | undefined, host: string | undefined, allowed?: string): boolean {
  if (origin === undefined) return true;
  if (allowed && origin === allowed) return true;
  try { return !!host && new URL(origin).host.toLowerCase() === host.toLowerCase(); } catch { return false; }
}

export async function buildApp(o: AppOptions): Promise<{ app: FastifyInstance; runtimes: Map<string, SessionRuntime> }> {
  const app = Fastify({ logger: false });
  const runtimes = new Map<string, SessionRuntime>();
  const micAttached = new Set<string>();

  // a JSON POST with an empty body (e.g. /end) is valid: treat it as {} instead of a 400
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try { done(null, body ? JSON.parse(body as string) : {}); } catch { done(Object.assign(new Error('invalid JSON body'), { statusCode: 400, code: 'INVALID_JSON' }), undefined); }
  });
  // one error shape for every failure: a status and a short code, never a stack, a path or a database message (found by the adversarial API fuzz)
  app.setErrorHandler((err, _req, reply) => {
    if (process.env.TALLY_DEBUG_ERRORS === '1') console.error('[tally] request error:', err);        // opt-in server-side diagnostics only; never sent to the client
    const status = typeof (err as { statusCode?: unknown }).statusCode === 'number' && (err as { statusCode: number }).statusCode >= 400 && (err as { statusCode: number }).statusCode < 500 ? (err as { statusCode: number }).statusCode : 500;
    const code = status === 500 ? 'internal_error' : String((err as { code?: unknown }).code ?? 'bad_request').slice(0, 40).toLowerCase();
    return reply.code(status).send({ error: code });
  });

  app.get('/healthz', async () => ({ ok: true }));

  // finished sessions leave memory after a short grace (their stored events stay in the database and the dashboard reads them from there)
  const prune = () => {
    const grace = o.endedGraceMs ?? 60000; const now = Date.now();
    for (const [id, rt] of runtimes) if (rt.endedAt !== undefined && now - rt.endedAt > grace) { runtimes.delete(id); micAttached.delete(id); }
  };

  // Two access tiers (D-39): GUEST (no login) reads everything and can trigger a demo scenario playback; OPERATOR (session-cookie
  // login, OR the `x-tally-operator` header used by scripts) unlocks every mutating route. Every /api request is pruned; only the
  // routes that write something call `requireOperator` (a guest hitting one gets 403, never a silently missing button).
  const sessions = new SessionStore();
  app.addHook('onRequest', async (req) => { if (req.url.startsWith('/api/')) prune(); });
  const amOperator = (req: FastifyRequest): boolean => isOperator(req, o.operatorToken, sessions);
  const requireOperator = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (amOperator(req)) return true;
    reply.code(403).send({ error: 'forbidden', message: 'operator sign-in required' });
    return false;
  };

  app.post('/api/login', async (req, reply) => {
    const body = (req.body ?? {}) as { token?: unknown };
    if (!tokenMatches(body.token, o.operatorToken)) return reply.code(401).send({ error: 'invalid_token' });
    setSessionCookie(req, reply, sessions.create());
    return { ok: true, role: 'operator' };
  });
  app.post('/api/logout', async (req, reply) => {
    sessions.destroy(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    clearSessionCookie(req, reply);
    return { ok: true, role: 'guest' };
  });
  // named /api/whoami, not /api/session: that path is a PREFIX of /api/sessions and Fastify's router would merge their tree nodes
  app.get('/api/whoami', async (req) => ({ role: isOperator(req, o.operatorToken, sessions) ? 'operator' : 'guest' }));

  app.post('/api/sessions', async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    const body = (req.body ?? {}) as { mode?: 'live' | 'demo' | 'replay' };
    try {
      const rt = await o.startRuntime({ mode: body.mode });
      runtimes.set(rt.session_id, rt);
      return reply.code(201).send({ session_id: rt.session_id });
    } catch (err) {
      // fail closed with a clear, non-sensitive reason (never a stack, never a header)
      return reply.code(503).send({ error: 'session_not_started', reason: err instanceof Error ? err.message : 'unknown' });
    }
  });

  app.get('/api/sessions/:id', async (req, reply) => {
    const rt = runtimes.get((req.params as { id: string }).id);
    // D-39: a guest may read a DEMO session (synthetic, already reviewed); a live session's state (transcripts, order) is operator-only
    if (!rt || (rt.mode !== 'demo' && !amOperator(req))) return reply.code(404).send({ error: 'not_found' });
    return rt.state();
  });

  app.post('/api/sessions/:id/end', async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    const rt = runtimes.get((req.params as { id: string }).id);
    if (!rt) return reply.code(404).send({ error: 'not_found' });
    const s = await rt.end();
    return { session_id: s.session_id, audio: { bytes: s.audio.bytes, duration_ms: s.audio.duration_ms, sha256: s.audio.sha256 }, ingest: s.ingest, order: s.order };
  });

  // Step 7: cases. Read-only except `accept`, which can only tag an existing, resolved candidate as a regression (never an order).
  // D-39: a guest reads DEMO-origin cases only (synthetic audio/transcripts, already reviewed, Step 13). A case from a LIVE call
  // (e.g. the pending human-mic validation) is operator-only, exactly like the live session it came from — never listed, 404 by id.
  app.get('/api/cases', async (req) => {
    const q = req.query as { session_id?: string; tag?: string };
    const cases = o.cases?.listCases({ session_id: q.session_id, tag: q.tag }) ?? [];
    return { cases: amOperator(req) ? cases : cases.filter((c) => c.origin_mode === 'demo') };
  });
  app.get('/api/cases/:id', async (req, reply) => {
    const c = o.cases?.getCase((req.params as { id: string }).id);
    if (!c || (c.origin_mode !== 'demo' && !amOperator(req))) return reply.code(404).send({ error: 'not_found' });
    // the audio itself is never served from here (pointer only); the snapshot is stored evidence, returned as parsed JSON
    // the server's file path never leaves the server: the browser gets a flag and fetches the recording by case id (/api/cases/:id/audio)
    const snap = JSON.parse(c.event_snapshot_json) as { audio?: { pointer?: string; offset_ms_at_call?: number } };
    if (snap.audio) snap.audio = { offset_ms_at_call: snap.audio.offset_ms_at_call };
    return { ...c, audio_pointer: undefined, has_audio: true, event_snapshot_json: undefined, event_snapshot: snap, expected_state: c.expected_state_json ? JSON.parse(c.expected_state_json) : null, expected_state_json: undefined };
  });
  app.get('/api/regressions/count', async () => o.cases?.caseCounts() ?? { cases: 0, candidates: 0, regressions: 0, patterns_flipped: 0 });
  app.post('/api/cases/:id/accept', async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    const r = o.cases?.acceptRegression((req.params as { id: string }).id, 'operator');
    if (!r) return reply.code(404).send({ error: 'not_found' });
    return r.ok ? { ok: true } : reply.code(r.reason === 'not_found' ? 404 : 409).send({ error: r.reason });
  });

  // Step 8: replay. Evidence tier = deterministic and fast (synchronous). Audio tier = real time x k against the live agent (background job).
  const audioJobs = new Map<string, { case_id: string; status: 'running' | 'done' | 'error'; report?: AudioReplayReport; error?: string }>();
  const replayErr = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, e: unknown) => {
    if (e instanceof ReplayError) return reply.code(e.code === 'case_not_found' ? 404 : 409).send({ error: e.code, message: e.message });
    return reply.code(500).send({ error: 'replay_failed' });
  };
  app.post('/api/cases/:id/replay', async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    if (!o.cases) return reply.code(404).send({ error: 'not_found' });
    const id = (req.params as { id: string }).id;
    const q = req.query as { tier?: string; k?: string };
    if (q.tier === 'evidence') {
      try { const r = await replayEvidence(o.cases, id); return { tier: 'evidence', result: r.result, label: r.label, diff: r.diff, run_id: r.run_id }; } catch (e) { return replayErr(reply, e); }
    }
    if (q.tier === 'audio') {
      const c = o.cases.getCase(id);
      if (!c) return reply.code(404).send({ error: 'case_not_found' });
      if (!c.expected_state_json) return reply.code(409).send({ error: 'no_expected_state', message: 'the audio tier needs a resolved case with an expected state' });
      if ([...audioJobs.values()].some((j) => j.case_id === id && j.status === 'running')) return reply.code(409).send({ error: 'already_running' });
      const k = q.k ? Number(q.k) : 3;
      if (!Number.isInteger(k) || k < 1 || k > 10) return reply.code(400).send({ error: 'bad_k' });
      const suite_run_id = `suite_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      audioJobs.set(suite_run_id, { case_id: id, status: 'running' });
      runAudioReplay({ store: o.cases, caseId: id, k, suiteRunId: suite_run_id, settleMs: o.replaySettleMs, startRuntime: (b) => o.startRuntime(b) })
        .then((report) => audioJobs.set(suite_run_id, { case_id: id, status: 'done', report }))
        .catch((e) => audioJobs.set(suite_run_id, { case_id: id, status: 'error', error: e instanceof Error ? e.message : String(e) }));
      return reply.code(202).send({ tier: 'audio', suite_run_id, k, note: 'runs in real time, k times; poll GET /api/replays/:suite_run_id' });
    }
    return reply.code(400).send({ error: 'tier must be evidence or audio' });
  });
  app.get('/api/replays/:suite_run_id', async (req, reply) => {
    const j = audioJobs.get((req.params as { suite_run_id: string }).suite_run_id);
    return j ? { ...j } : reply.code(404).send({ error: 'not_found' });
  });
  app.get('/api/cases/:id/replays', async (req, reply) => {
    if (!o.cases) return reply.code(404).send({ error: 'not_found' });
    const id = (req.params as { id: string }).id;
    const c = o.cases.getCase(id);
    if (!c || (c.origin_mode !== 'demo' && !amOperator(req))) return reply.code(404).send({ error: 'not_found' });
    const runs = o.cases.listReplayRuns(id).map((r) => ({ ...r, diff: r.diff_json ? JSON.parse(r.diff_json) : null, diff_json: undefined, actual_state_json: undefined }));
    const evidence = runs.filter((r) => r.tier === 'evidence');
    const bySuite = new Map<string, typeof runs>();
    for (const r of runs.filter((x) => x.tier === 'audio')) bySuite.set(r.suite_run_id ?? '', [...(bySuite.get(r.suite_run_id ?? '') ?? []), r]);
    return {
      runs,
      // the ONLY place labels are produced: evidence is "(deterministic)", audio is "k/N passed" (see describeReplay)
      latest_evidence: evidence.length ? describeReplay('evidence', [evidence[evidence.length - 1]!.result]).label : null,
      audio_suites: [...bySuite.entries()].map(([suite_run_id, rs]) => ({ suite_run_id, ...describeReplay('audio', rs.map((r) => r.result)) })),
    };
  });

  // Step 9: config registry, "run all cases", promotion, rollback. The API can REQUEST; the data layer decides (committer-configs.ts).
  const cfgErr = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, e: unknown, extra: Record<string, unknown> = {}) => {
    if (e instanceof ConfigError) return reply.code(e.code === 'BAD_CONFIG' ? 400 : e.code === 'NOT_FOUND' ? 404 : 409).send({ error: e.code, message: e.message, ...extra });
    return reply.code(500).send({ error: 'config_failed' });
  };
  const suiteJobs = new Map<string, { config_version: string; status: 'running' | 'done' | 'error'; report?: SuiteReport; error?: string }>();
  app.post('/api/configs', async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    if (!o.cases) return reply.code(404).send({ error: 'not_found' });
    const b = (req.body ?? {}) as { version?: string; prompt_text?: string; gating_params?: unknown; parent_version?: string | null };
    try {
      // the tool schema is ALWAYS the contract's (hold-mode for mutating tools is a safety invariant a config may not change)
      const c = o.cases.createConfig({ version: String(b.version ?? ''), prompt_text: String(b.prompt_text ?? ''), tool_schema_json: JSON.stringify(toolDeclarations()), gating_params: b.gating_params, parent_version: b.parent_version });
      return reply.code(201).send({ version: c.version, parent_version: c.parent_version, prompt_hash: c.prompt_hash, tool_schema_hash: c.tool_schema_hash, gating_params: c.gating_params, promoted: !!c.promoted });
    } catch (e) { return cfgErr(reply, e); }
  });
  const pub = (c: { version: string; parent_version: string | null; prompt_hash: string; tool_schema_hash: string; created_at: number; promoted: 0 | 1; gating_params: unknown; integrity_ok: boolean }) =>
    ({ version: c.version, parent_version: c.parent_version, prompt_hash: c.prompt_hash, tool_schema_hash: c.tool_schema_hash, created_at: c.created_at, active: !!c.promoted, gating_params: c.gating_params, integrity_ok: c.integrity_ok });
  app.get('/api/configs', async () => ({ configs: (o.cases?.listConfigs() ?? []).map(pub) }));
  app.get('/api/configs/active', async (_req, reply) => { const c = o.cases?.activeConfig(); return c ? pub(c) : reply.code(404).send({ error: 'no_active_config' }); });
  app.get('/api/configs/:v', async (req, reply) => {
    const v = (req.params as { v: string }).v; const c = o.cases?.getConfig(v);
    return c ? { ...pub(c), prompt_text: c.prompt_text, history: o.cases!.configHistory(v) } : reply.code(404).send({ error: 'not_found' });
  });
  app.get('/api/compare', async () => ({ table: o.cases?.compareTable() ?? [] }));

  app.post('/api/suite/run', async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    if (!o.cases) return reply.code(404).send({ error: 'not_found' });
    const b = (req.body ?? {}) as { config_version?: string; audio?: boolean; k?: number };
    const version = String(b.config_version ?? '');
    const cfg = o.cases.getConfig(version);
    if (!cfg) return reply.code(404).send({ error: 'NOT_FOUND', message: `no config ${version}` });
    if ([...suiteJobs.values()].some((j) => j.status === 'running')) return reply.code(409).send({ error: 'suite_already_running' });
    const store = o.cases;
    const audio = b.audio ? async (caseId: string, c: { version: string; prompt_text: string }) => {
      const r = await runAudioReplay({ store, caseId, k: b.k ?? 3, configVersion: c.version, settleMs: o.replaySettleMs, startRuntime: (bd) => o.startRuntime({ ...bd, systemPrompt: c.prompt_text, configVersion: c.version }) });
      return { overall: r.overall, label: r.label, k: r.k, passed: r.passed, suite_run_id: r.suite_run_id };
    } : undefined;
    const run = () => runSuite(store, { config_version: version, audio });
    if (!audio) {
      const report = await run();                                    // evidence tier only: deterministic and fast, answered synchronously
      return reply.code(200).send(report);
    }
    const id = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    suiteJobs.set(id, { config_version: version, status: 'running' });
    run().then((report) => suiteJobs.set(id, { config_version: version, status: 'done', report })).catch((e) => suiteJobs.set(id, { config_version: version, status: 'error', error: e instanceof Error ? e.message : String(e) }));
    return reply.code(202).send({ job_id: id, note: 'audio tier runs the live agent in real time, k times per case; poll GET /api/suite/:job_id' });
  });
  app.get('/api/suite/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const j = suiteJobs.get(id);
    if (j) return { ...j };
    const s = o.cases?.getSuiteRun(id);                              // a finished run, by its own suite_run_id
    return s ? { status: s.status, config_version: s.config_version, blocking: JSON.parse(s.blocking_json), case_ids: JSON.parse(s.case_ids_json), consumed: s.consumed_at !== null, validation_notice: SUITE_VALIDATION_NOTICE } : reply.code(404).send({ error: 'not_found' });
  });

  app.post('/api/configs/:v/promote', async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    if (!o.cases) return reply.code(404).send({ error: 'not_found' });
    const v = (req.params as { v: string }).v;
    const rawSid = ((req.body ?? {}) as { suite_run_id?: unknown }).suite_run_id;
    const sid = typeof rawSid === 'string' ? rawSid : undefined;                     // anything else can never name a suite run
    try {
      const r = o.cases.activateConfig(v, sid);
      return { promoted: v, previous: r.previous, validation_notice: SUITE_VALIDATION_NOTICE };
    } catch (e) {
      // a blocked promotion names the failing cases (from the stored suite run), so the operator can see exactly what regressed
      const s = sid ? o.cases.getSuiteRun(sid) : undefined;
      return cfgErr(reply, e, { blocking: s && s.config_version === v ? JSON.parse(s.blocking_json) : [], validation_notice: SUITE_VALIDATION_NOTICE });
    }
  });
  app.post('/api/configs/rollback', async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    if (!o.cases) return reply.code(404).send({ error: 'not_found' });
    try { return o.cases.rollbackConfig(); } catch (e) { return cfgErr(reply, e); }
  });

  // Server-sent events: the live evidence stream for the dashboard (typed TallyEvents; the wire `raw` payload is not forwarded).
  app.get('/api/live/:id', (req, reply) => {
    const rt = runtimes.get((req.params as { id: string }).id);
    // D-39: a guest may watch a DEMO session live; a real live call's stream (transcripts, order) is operator-only
    if (!rt || (rt.mode !== 'demo' && !amOperator(req))) return reply.code(404).send({ error: 'not_found' });
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const seen = new Set<string>();
    const send = (e: TallyEvent) => { if (seen.has(e.id)) return; seen.add(e.id); const { raw: _raw, ...rest } = e as TallyEvent & { raw?: unknown }; reply.raw.write(`data: ${JSON.stringify(rest)}\n\n`); };
    reply.raw.write(': connected\n\n');
    // backlog first (a dashboard attaching mid-call, or to a demo that has already started, must see the whole call), then live; ids de-duplicate
    for (const e of o.cases?.sessionEvents(rt.session_id) ?? []) send(e as unknown as TallyEvent);
    const off = rt.subscribe(send);
    const beat = setInterval(() => reply.raw.write(': keepalive\n\n'), 15000);
    req.raw.on('close', () => { off(); clearInterval(beat); });
  });

  // Mic bridge: browser/microphone -> THIS server -> the runtime (which feeds the agent, recorder, independent STT and local check).
  const wss = new WebSocketServer({ noServer: true, maxPayload: o.maxFrameBytes ?? 8192 });
  app.server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0];
    const origin = req.headers.origin;
    if (path !== '/ws/mic' || !originAllowed(origin, req.headers.host, o.allowedOrigin)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('error', () => undefined);
  wss.on('connection', (ws) => {
    // a protocol violation (e.g. an oversize frame) closes the socket with the right code; the error event must never be unhandled
    ws.on('error', () => undefined);
    let rt: SessionRuntime | null = null;
    let offAudio: (() => void) | undefined;
    let pendingMs = 0;
    const authTimer = setTimeout(() => { if (!rt) ws.close(1008, 'auth timeout'); }, o.authTimeoutMs ?? 5000);
    ws.on('message', (data, isBinary) => {
      if (!rt) {
        // first frame authenticates: browsers cannot set headers on a WebSocket, and a token in the URL would leak into logs
        try {
          const m = JSON.parse(data.toString()) as { session?: string; token?: string };
          const candidate = m.session ? runtimes.get(m.session) : undefined;
          if (isBinary || !tokenMatches(m.token, o.operatorToken) || !candidate || micAttached.has(candidate.session_id)) { ws.close(1008, 'unauthorized'); return; }
          rt = candidate; micAttached.add(candidate.session_id); clearTimeout(authTimer);
          // the agent's audible reply goes back to the browser as binary PCM16 24 kHz frames (playback only: the page cannot send it anywhere else)
          offAudio = rt.onAudio((pcm) => { if (ws.readyState === ws.OPEN) ws.send(pcm, { binary: true }); });
          ws.send(JSON.stringify({ type: 'ready' }));
        } catch { ws.close(1008, 'bad auth frame'); }
        return;
      }
      if (!isBinary) return;
      const pcm = new Uint8Array(data as Buffer);
      pendingMs += pcm.byteLength / 48;
      if (pendingMs > (o.maxQueuedAudioMs ?? 5000)) { ws.close(1013, 'sending faster than real time'); return; }
      rt.sendPcm(pcm).catch(() => undefined).finally(() => { pendingMs -= pcm.byteLength / 48; });
    });
    ws.on('close', () => { clearTimeout(authTimer); offAudio?.(); if (rt) micAttached.delete(rt.session_id); });
  });

  registerExtraRoutes(app, o, runtimes, amOperator);

  app.addHook('onClose', async () => { wss.close(); for (const rt of runtimes.values()) await rt.end().catch(() => undefined); });
  return { app, runtimes };
}
