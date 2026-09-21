// Deployment smoke test: everything that can be checked about a RUNNING Tally server from outside, over HTTP and WebSocket.
// It is what the audit found missing: run against the deployed URL, not localhost, and compare with what this codebase does locally.
//
// What it checks: the dashboard is served (with its security headers); the API is closed without the token and open with it; the mic
// socket accepts the page's OWN origin and refuses a foreign one (the exact defect that once made the mic page unusable); the deterministic
// demo scenarios produce the SAME verdicts/orders/cases as a fresh local run of this code; stored cases, recordings and deterministic
// replay work; nothing leaks a file path or a credential.
// What it does NOT check: a real browser (layout, microphone capture, audio playback) or the live managed agent.
// NOTE: running scenarios ADDS demo sessions and cases to the target's database. Use `dry` to skip them, or run this BEFORE the demo seed.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { initDatabase } from '../../db/src/index.js';
import { Store } from '../../reliability/src/committer.js';
import { runScenario, SCENARIOS, type ScenarioName, type ScenarioResult } from '../../server/src/demo/scenarios.js';

export interface SmokeCheck { name: string; ok: boolean; detail: string }
export interface SmokeOptions {
  /** scenarios to play on the target (default: all six) */
  scenarios?: readonly ScenarioName[];
  /** skip everything that writes to the target's database */
  dry?: boolean;
  /** also run the adversarial harness on the target (about 7 s) */
  adversarial?: boolean;
  /** compare each scenario with a fresh LOCAL run of this code (default true; needs no network) */
  compareBaseline?: boolean;
  /** an API key to search the served files for (defaults to ASSEMBLYAI_API_KEY in this process's environment, when set) */
  secretToScan?: string;
  scenarioTimeoutMs?: number;
  log?: (line: string) => void;
}

const LEAK = /[A-Za-z]:\\|\/tmp\/|\/var\/(?:folders|lib)|\/home\/|\/Users\/|\.pcm\b|\.sqlite|node_modules|at \S+ \(|\bstack\b/;

/** what must be identical between two runs of a scenario, whatever else is already in the database */
export function comparable(r: ScenarioResult): unknown {
  if (r.scenario === 'C') return { scenario: 'C', replay: r.replay };                       // C reuses an existing case, so its sessions depend on the database
  return {
    scenario: r.scenario, deterministic: r.deterministic, scripted: r.scripted,
    sessions: r.sessions.map((s) => ({ ...s, cases: s.cases.map(({ pattern_key, conflict_type, resolution }) => ({ pattern_key, conflict_type, resolution })) })),   // tags depend on how many cases came before
  };
}
const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

async function localBaseline(name: ScenarioName): Promise<ScenarioResult> {
  const dir = mkdtempSync(join(tmpdir(), 'tally-smoke-'));
  initDatabase(join(dir, 'b.sqlite'));
  const store = new Store(join(dir, 'b.sqlite'));
  try { return await runScenario(name, { store, audioDir: join(dir, 'audio') }); } finally { store.close(); }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** open the mic socket the way a browser does (with an Origin) and report what the server did */
function micProbe(wsUrl: string, origin: string | undefined, firstFrame?: unknown): Promise<{ outcome: 'open' | 'refused' | 'error'; status?: number; closeCode?: number }> {
  return new Promise((resolve) => {
    let done = false; const fin = (r: { outcome: 'open' | 'refused' | 'error'; status?: number; closeCode?: number }) => { if (!done) { done = true; resolve(r); } };
    const w = new WebSocket(wsUrl, origin === undefined ? {} : { origin });
    const t = setTimeout(() => { w.terminate(); fin({ outcome: 'error' }); }, 8000);
    w.on('unexpected-response', (_q, rsp) => { clearTimeout(t); fin({ outcome: 'refused', status: rsp.statusCode }); });
    w.on('error', () => { clearTimeout(t); fin({ outcome: 'error' }); });
    w.on('open', () => { if (firstFrame === undefined) { clearTimeout(t); fin({ outcome: 'open' }); w.close(); } else w.send(JSON.stringify(firstFrame)); });
    w.on('close', (code) => { clearTimeout(t); fin({ outcome: 'open', closeCode: code }); });
  });
}

export async function runSmoke(baseUrl: string, token: string, o: SmokeOptions = {}): Promise<{ checks: SmokeCheck[]; ok: boolean }> {
  const base = baseUrl.replace(/\/+$/, '');
  const u = new URL(base);
  const wsUrl = `${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}/ws/mic`;
  const checks: SmokeCheck[] = [];
  const log = o.log ?? (() => undefined);
  const check = (name: string, ok: boolean, detail = '') => { checks.push({ name, ok, detail }); log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
  const guard = async (name: string, f: () => Promise<void>) => { try { await f(); } catch (e) { check(name, false, `threw: ${e instanceof Error ? e.message : String(e)}`.slice(0, 160)); } };
  const H = { 'x-tally-operator': token };
  const get = (p: string, auth = true) => fetch(base + p, { headers: auth ? H : {} });
  const json = async (p: string, init: RequestInit = {}) => { const r = await fetch(base + p, { ...init, headers: { ...H, ...(init.headers as Record<string, string> | undefined) } }); return { status: r.status, body: (await r.json().catch(() => null)) as any, headers: r.headers }; };
  const secret = o.secretToScan ?? process.env.ASSEMBLYAI_API_KEY;

  // 1. reachable, and the dashboard is what we shipped
  await guard('server is reachable (GET /healthz)', async () => { const r = await get('/healthz', false); check('server is reachable (GET /healthz)', r.status === 200, `HTTP ${r.status}`); });
  await guard('dashboard page is served', async () => {
    const r = await get('/', false); const html = await r.text();
    const csp = r.headers.get('content-security-policy') ?? '';
    check('dashboard page is served', r.status === 200 && /text\/html/.test(r.headers.get('content-type') ?? '') && html.includes('/app.js'), `HTTP ${r.status}`);
    check('dashboard security headers (CSP without inline/eval, nosniff, no-referrer)', /script-src 'self'/.test(csp) && !/unsafe-inline|unsafe-eval/.test(csp) && r.headers.get('x-content-type-options') === 'nosniff' && r.headers.get('referrer-policy') === 'no-referrer', csp ? 'CSP present' : 'no CSP header');
  });
  await guard('dashboard script and stylesheet are served', async () => {
    const js = await get('/app.js', false); const css = await get('/style.css', false); const body = await js.text();
    check('dashboard script and stylesheet are served', js.status === 200 && css.status === 200 && /javascript/.test(js.headers.get('content-type') ?? ''), `app.js HTTP ${js.status} (${body.length} bytes), style.css HTTP ${css.status}`);
    check('served script contains no operator token, no API key, no vendor host', !body.includes(token) && !(secret && secret.length >= 8 && body.includes(secret)) && !/assemblyai\.com/i.test(body));
  });

  // 2. the API is closed without the token and open with it; errors are uniform and leak nothing
  await guard('API is closed without the token', async () => {
    const a = await get('/api/metrics', false); const b = await fetch(`${base}/api/metrics`, { headers: { 'x-tally-operator': `${token}x` } });
    check('API is closed without the token (and with a wrong one)', a.status === 401 && b.status === 401, `no token ${a.status}, wrong token ${b.status}`);
  });
  await guard('unknown routes and bad input give uniform, non-leaking errors', async () => {
    const r1 = await json('/api/does-not-exist'); const r2 = await fetch(`${base}/api/configs`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: '{"broken":' });
    const t = JSON.stringify(r1.body) + (await r2.text());
    check('unknown routes and malformed JSON are 4xx and leak no path or stack', r1.status === 404 && r2.status === 400 && !LEAK.test(t), `unknown ${r1.status}, malformed ${r2.status}`);
  });
  await guard('authenticated API answers', async () => {
    const [sc, m, cfg, ss] = await Promise.all([json('/api/demo/scenarios'), json('/api/metrics'), json('/api/configs/active'), json('/api/sessions')]);
    check('demo banner says the demo is scripted', sc.status === 200 && /scripted \(not the live agent\)/.test(sc.body?.banner ?? ''), `HTTP ${sc.status}`);
    check('metrics are computed from stored rows', m.status === 200 && m.body?.generated_from === 'stored rows');
    check('an active config version exists and passes its hash check', cfg.status === 200 && cfg.body?.active === true && cfg.body?.integrity_ok === true, cfg.status === 200 ? `active ${cfg.body?.version}` : `HTTP ${cfg.status} (start the server once so the baseline config is created)`);
    check('sessions endpoint answers', ss.status === 200 && Array.isArray(ss.body?.sessions));
  });

  // 3. the mic socket, opened like a browser page served from this URL
  await guard('mic socket', async () => {
    const own = await micProbe(wsUrl, u.origin);
    check('mic socket accepts the page\'s OWN origin', own.outcome === 'open', own.outcome === 'refused' ? `refused HTTP ${own.status}` : own.outcome);
    const foreign = await micProbe(wsUrl, 'https://evil.example');
    check('mic socket refuses a foreign origin', foreign.outcome === 'refused' && foreign.status === 403, `${foreign.outcome}${foreign.status ? ` ${foreign.status}` : ''}`);
    const bad = await micProbe(wsUrl, u.origin, { session: 'smoke-no-such-session', token: `${token}x` });
    check('mic socket closes a wrong token / unknown session (1008), never streams', bad.outcome === 'open' && bad.closeCode === 1008, `close ${bad.closeCode}`);
    const ok = await micProbe(wsUrl, u.origin, { session: 'smoke-no-such-session', token });
    check('mic socket authenticates the real token but refuses an unknown session (1008)', ok.outcome === 'open' && ok.closeCode === 1008, `close ${ok.closeCode}`);
  });

  if (o.dry) { log('dry run: scenarios skipped (nothing written to the target)'); return { checks, ok: checks.every((c) => c.ok) }; }

  // 4. deterministic demo: the target must behave exactly like a fresh local run of this code
  const scenarios = o.scenarios ?? SCENARIOS;
  let firstCase: string | undefined;
  for (const name of scenarios) {
    await guard(`scenario ${name}`, async () => {
      const started = await json(`/api/demo/${name}`, { method: 'POST' });
      if (started.status !== 202) return check(`scenario ${name} starts`, false, `HTTP ${started.status} ${JSON.stringify(started.body).slice(0, 80)}`);
      const t0 = Date.now(); let run: any;
      for (;;) { run = (await json(`/api/demo/runs/${started.body.run_id}`)).body; if (!run || run.status !== 'running') break; if (Date.now() - t0 > (o.scenarioTimeoutMs ?? 180000)) break; await sleep(300); }
      if (run?.status !== 'done') return check(`scenario ${name} completes`, false, run?.status === 'error' ? `error: ${String(run.error).slice(0, 100)}` : 'timed out');
      const remote = run.results[0] as ScenarioResult;
      check(`scenario ${name} completes on the target`, true, `${((Date.now() - t0) / 1000).toFixed(1)} s`);
      check(`scenario ${name} is labelled scripted/deterministic`, remote.deterministic === true && remote.scripted?.agent === true && /scripted \(not the live agent\)/.test(remote.banner));
      check(`scenario ${name}: no path or stack in the result`, !LEAK.test(JSON.stringify(remote)));
      if (name !== 'C') for (const s of remote.sessions) check(`scenario ${name}: final order equals the declared intent`, JSON.stringify([...(s.final_order?.lines ?? [])].map((l: any) => [l.item_id, l.quantity]).sort()) === JSON.stringify([...s.intent.items].map((i) => [i.item_id, i.quantity]).sort()), `${s.final_order ? `total ${(s.final_order.total_cents / 100).toFixed(2)} ${s.final_order.status}` : 'no order'}`);
      if (o.compareBaseline !== false) {
        const local = await localBaseline(name);
        const same = stable(comparable(remote)) === stable(comparable(local));
        check(`scenario ${name} is IDENTICAL to a fresh local run`, same, same ? 'verdicts, orders, cases' : 'DIFFERENT: compare the deployed result with `npm run demo -- ' + name + ' --json`');
      }
      const sid = remote.sessions[0] ? (run.sessions as string[])[0] : undefined;
      if (sid) {
        const ev = await json(`/api/sessions/${sid}/events`);
        const verdicts = (ev.body?.events ?? []).filter((e: any) => e.kind === 'verdict').length;
        check(`scenario ${name}: the stored event stream is complete`, ev.status === 200 && verdicts === remote.sessions[0]!.verdicts.length, `${verdicts} verdict events`);
      }
    });
  }

  // 5. stored cases, recordings, deterministic replay (uses the newest case on the target)
  await guard('stored case', async () => {
    const list = await json('/api/cases'); const cases = (list.body?.cases ?? []) as { id: string; resolution: string }[];
    if (!cases.length) return check('stored cases are readable', true, 'no cases on the target yet (skipped)');
    firstCase = cases.filter((c) => c.resolution === 'resolved').at(-1)?.id ?? cases.at(-1)!.id;
    const d = await json(`/api/cases/${firstCase}`);
    check('case detail exposes has_audio, never a file path', d.status === 200 && d.body?.has_audio === true && d.body?.audio_pointer === undefined && !LEAK.test(JSON.stringify(d.body)), `HTTP ${d.status}`);
    const a = await get(`/api/cases/${firstCase}/audio`); const buf = Buffer.from(await a.arrayBuffer());
    check('case recording streams as a WAV by case id', a.status === 200 && a.headers.get('content-type') === 'audio/wav' && buf.subarray(0, 4).toString() === 'RIFF', `${buf.length} bytes`);
    const r1 = await json(`/api/cases/${firstCase}/replay?tier=evidence`, { method: 'POST' }); const r2 = await json(`/api/cases/${firstCase}/replay?tier=evidence`, { method: 'POST' });
    check('evidence-tier replay is a labelled, byte-identical deterministic result', r1.status === 200 && /\(deterministic\)$/.test(r1.body?.label ?? '') && stable(r1.body?.diff) === stable(r2.body?.diff), r1.body?.label);
  });
  if (o.adversarial) await guard('adversarial', async () => {
    const r = await json('/api/adversarial');
    check('adversarial harness on the target: every lie caught, no clean call held', r.status === 200 && r.body?.uncaught === 0 && r.body?.false_positives === 0, r.body ? `${r.body.caught}/${r.body.total} caught, ${r.body.false_positives} false positives` : `HTTP ${r.status}`);
  });
  return { checks, ok: checks.every((c) => c.ok) };
}
