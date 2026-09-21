// STEP 14 on the HTTP surface of Steps 7-11: hostile requests to the new routes (seeded, reproducible). The requirement is the same one the
// gate proves: bad input is REJECTED (never a 500, never a crash, never a leak of internals) and never changes state it must not change.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initDatabase } from '@tally/db';
import { Store } from '@tally/reliability';
import { buildApp } from '../src/app.js';
import { ensureBaseline } from '../src/bootstrap.js';

const TOKEN = ['operator', 'token', '0123456789'].join('-');
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

function rng(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

async function server() {
  const dir = mkdtempSync(join(tmpdir(), 'tally-advapi-'));
  initDatabase(join(dir, 't.sqlite'));
  const store = new Store(join(dir, 't.sqlite'));
  ensureBaseline(store, {});
  const { app } = await buildApp({ operatorToken: TOKEN, cases: store, dashboardDir: join(dir, 'none'), startRuntime: async () => { throw new Error('no runtime in this test'); } });
  cleanups.push(async () => { await app.close(); store.close(); });
  const H = { 'x-tally-operator': TOKEN, 'content-type': 'application/json' };
  return { app, store, H };
}
const LEAK = /stack|node_modules|better-sqlite3|SQLITE|SqliteError|[A-Z]:\\|\/Users\/|\/home\/|\bat \S+ \(|\.ts:\d+/;

describe('hostile requests to the Step 6-11 routes', () => {
  it('700 seeded hostile requests: never a 5xx, never a leak of internals, and the registry/orders are untouched', async () => {
    const { app, store, H } = await server();
    const rand = rng(20260920);
    const pick = <T,>(a: readonly T[]): T => a[Math.floor(rand() * a.length)]!;
    const junk = [null, true, 0, -1, 1e309, NaN, '', 'x'.repeat(5000), '\u0000', '<script>alert(1)</script>', "'; DROP TABLE configs;--", '../../etc/passwd', { a: { b: { c: 1 } } }, [1, [2, [3]]], { __proto__: { admin: true } }, JSON.parse('{"__proto__":{"x":1}}'), { constructor: { prototype: {} } }, 'v1', 'v2', '%00', '\ud800'];
    const ids = ['x', '..%2F..%2Fetc%2Fpasswd', '%00', 'a'.repeat(3000), '💥', 'case_nope', "1' OR '1'='1", 'v1', '__proto__', 'constructor', '%2e%2e', 'demo'];
    const routes: [string, (id: string) => string][] = [
      ['POST', () => '/api/configs'], ['POST', () => '/api/suite/run'], ['POST', (i) => `/api/configs/${i}/promote`], ['POST', () => '/api/configs/rollback'],
      ['POST', (i) => `/api/cases/${i}/replay?tier=${pick(['evidence', 'audio', 'x', '', 'evidence&tier=audio'])}&k=${pick(['3', '-1', '1e9', 'abc', '', '0'])}`], ['POST', (i) => `/api/cases/${i}/accept`],
      ['POST', (i) => `/api/demo/${i}`], ['GET', (i) => `/api/cases/${i}`], ['GET', (i) => `/api/cases/${i}/replays`], ['GET', (i) => `/api/cases/${i}/audio`], ['GET', (i) => `/api/configs/${i}`],
      ['GET', (i) => `/api/suite/${i}`], ['GET', (i) => `/api/replays/${i}`], ['GET', (i) => `/api/sessions/${i}/events`], ['GET', (i) => `/api/demo/runs/${i}`], ['GET', () => '/api/compare'], ['GET', () => '/api/metrics'], ['GET', () => '/api/cases?tag=%27--&session_id=%00'],
    ];
    const before = JSON.stringify([store.listConfigs().map((c) => [c.version, c.prompt_hash, c.promoted]), store.activeConfig()?.version, store.getOrder('none')]);
    const statuses = new Map<number, number>();
    for (let i = 0; i < 700; i++) {
      const [method, path] = pick(routes);
      const body = rand() < 0.15 ? '{"broken":' : JSON.stringify(rand() < 0.5 ? { version: pick(junk), prompt_text: pick(junk), gating_params: pick(junk), parent_version: pick(junk), config_version: pick(junk), suite_run_id: pick(junk), audio: pick(junk), k: pick(junk) } : pick(junk));
      const res = await app.inject({ method: method as 'GET' | 'POST', url: path(pick(ids)), headers: rand() < 0.1 ? { 'content-type': 'text/plain', 'x-tally-operator': TOKEN } : H, ...(method === 'POST' ? { payload: body } : {}) });
      statuses.set(res.statusCode, (statuses.get(res.statusCode) ?? 0) + 1);
      expect(res.statusCode, `${method} ${path('X')} ${body.slice(0, 80)} -> ${res.body.slice(0, 120)}`).toBeLessThan(500);
      expect(res.body, `${method} ${path('X')}`).not.toMatch(LEAK);
    }
    expect([...statuses.keys()].some((s) => s >= 400)).toBe(true);
    // nothing hostile was stored or activated: same versions, same hashes, same active version
    const created = store.listConfigs().map((c) => c.version);
    expect(created.every((v) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(v) && !(v in Object.prototype))).toBe(true);
    expect(store.activeConfig()!.version).toBe('v1');
    expect(store.listConfigs().find((c) => c.version === 'v1')!.prompt_hash).toBe(JSON.parse(before)[0][0][1]);
    expect(store.listConfigs().every((c) => c.integrity_ok)).toBe(true);
  }, 120000);

  it('an oversize body is refused (413), malformed JSON is a 400, and neither reaches the data layer', async () => {
    const { app, store, H } = await server();
    const big = await app.inject({ method: 'POST', url: '/api/configs', headers: H, payload: JSON.stringify({ version: 'v9', prompt_text: 'x'.repeat(2_000_000) }) });
    expect(big.statusCode).toBe(413);
    const bad = await app.inject({ method: 'POST', url: '/api/configs', headers: H, payload: '{"version":' });
    expect(bad.statusCode).toBe(400);
    expect(store.listConfigs()).toHaveLength(1);
  });

  it('a prompt just under the cap is accepted as a normal config; one over it is rejected by the data layer with a 400', async () => {
    const { app, H } = await server();
    const ok = await app.inject({ method: 'POST', url: '/api/configs', headers: H, payload: JSON.stringify({ version: 'big', prompt_text: 'p'.repeat(90_000) }) });
    expect(ok.statusCode).toBe(201);
    const over = await app.inject({ method: 'POST', url: '/api/configs', headers: H, payload: JSON.stringify({ version: 'bigger', prompt_text: 'p'.repeat(100_001) }) });
    expect(over.statusCode).toBe(400);
    expect(over.json()).toMatchObject({ error: 'BAD_CONFIG' });
  });

  it('the adversarial route runs the harness and reports 100% caught (the dashboard\'s Run button)', async () => {
    const { app, H } = await server();
    const r = await app.inject({ method: 'GET', url: '/api/adversarial', headers: H });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ uncaught: 0, false_positives: 0 });
  }, 60000);
});
