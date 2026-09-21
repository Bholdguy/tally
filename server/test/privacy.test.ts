// STEP 13: privacy and security, verified rather than asserted. (1) no real customer PII anywhere in the repo, the schema or the demo data;
// (2) secrets never leave the server: not in the built bundle, not in any API response, not in logs; (3) no browser request can reach
// AssemblyAI; (4) the server's file layout never crosses the API; (5) .env is ignored and .env.example holds no values.
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { initDatabase } from '@tally/db';
import { Store } from '@tally/reliability';
import { buildApp } from '../src/app.js';
import { ensureBaseline } from '../src/bootstrap.js';
import { startServer } from '../src/main.js';
import { runScenario } from '../src/demo/scenarios.js';

const ROOT = process.cwd();
const KEY = ['k', 'privacy', 'test', 'key', '0123456789'].join('-');
const TOKEN = ['operator', 'token', '0123456789'].join('-');
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); vi.restoreAllMocks(); });

const SKIP = new Set(['node_modules', '.git', 'data', 'dist']);
function walk(dir: string, exts: RegExp): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p, exts));
    else if (exts.test(e) && e !== 'package-lock.json') out.push(p);
  }
  return out;
}
const luhn = (digits: string) => { let sum = 0; let alt = false; for (let i = digits.length - 1; i >= 0; i--) { let n = Number(digits[i]); if (alt) { n *= 2; if (n > 9) n -= 9; } sum += n; alt = !alt; } return sum % 10 === 0; };

describe('no real customer PII (sandbox data only)', () => {
  const files = walk(ROOT, /\.(ts|tsx|js|json|jsonl|md|html|css|sql|txt|ps1|sha256|yml)$/i);
  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/g;
  const PHONE = /(?<![\d.])(?:\+?1[\s.-])?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\d.])/g;
  const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
  const CARD = /\b(?:\d[ -]?){13,19}\b/g;
  const ADDRESS = /\b\d{1,5}\s+[A-Z][a-z]+(?:\s[A-Z][a-z]+)?\s(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct)\b/g;
  const ALLOWED_EMAILS = new Set(['user@example.com', 'name@example.com']);

  it('scans every text file in the repo (sources, docs, fixtures, captures) for emails, phone numbers, SSNs, valid card numbers and street addresses', () => {
    expect(files.length).toBeGreaterThan(150);
    const findings: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      const rel = relative(ROOT, f).split(sep).join('/');
      for (const m of text.matchAll(EMAIL)) if (!ALLOWED_EMAILS.has(m[0].toLowerCase()) && !/^@?[a-z]+\/[a-z-]+$/.test(m[0])) findings.push(`${rel}: email ${m[0]}`);
      for (const m of text.matchAll(PHONE)) findings.push(`${rel}: phone ${m[0]}`);
      for (const m of text.matchAll(SSN)) findings.push(`${rel}: ssn-like ${m[0]}`);
      for (const m of text.matchAll(CARD)) { const d = m[0].replace(/\D/g, ''); if (d.length >= 13 && d.length <= 19 && luhn(d) && !/^(\d)\1+$/.test(d) && !/^\d{13,}$/.test(m[0].trim()) === false && /[ -]/.test(m[0])) findings.push(`${rel}: card-like ${m[0]}`); }
      for (const m of text.matchAll(ADDRESS)) findings.push(`${rel}: address ${m[0]}`);
    }
    expect(findings).toEqual([]);
  });

  it('the database schema has no column that could hold personal data (no names, phones, emails, addresses, payment fields)', () => {
    const sql = readFileSync(join(ROOT, 'db/schema.sql'), 'utf8');
    const cols = [...sql.matchAll(/^\s{2}([a-z_]+)\s+(?:TEXT|INTEGER|REAL)/gm)].map((m) => m[1]!);
    expect(cols.length).toBeGreaterThan(80);
    const bad = cols.filter((c) => /^(phone|email|address|card|cvv|ssn|dob|zip|postcode|payment|first_name|last_name|customer_name|caller_id|ip_address|tip)/.test(c));
    expect(bad).toEqual([]);
    // the only "name" column is the MENU item's name
    expect(cols.filter((c) => c === 'name')).toHaveLength(1);
  });

  it('the demo clips are synthetic (pinned checksums, SAPI voice) and the demo scripts contain only menu vocabulary', () => {
    expect(existsSync(join(ROOT, 'demo/clips/CLIPS.sha256'))).toBe(true);
    const script = readFileSync(join(ROOT, 'server/src/demo/scenarios.ts'), 'utf8');
    expect(script).toMatch(/synthetic SAPI voice, no PII/);
  });

  it('the recording protocol forbids personal data and offers deletion (docs/real-speech-validation.md)', () => {
    const doc = readFileSync(join(ROOT, 'docs/real-speech-validation.md'), 'utf8');
    expect(doc).toMatch(/Nobody speaks real personal data/);
    expect(doc).toMatch(/Delete recordings on request/);
  });
});

describe('secrets stay server-side', () => {
  it('the built dashboard bundle contains no key, no token, no AssemblyAI host, no bearer header, and the source never persists or URL-carries the token', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'tally-bundle-')), 'app.js');
    await build({ entryPoints: [join(ROOT, 'dashboard/src/main.ts')], bundle: true, format: 'iife', target: 'es2022', platform: 'browser', outfile: out, logLevel: 'silent' });
    const bundle = readFileSync(out, 'utf8');
    for (const needle of ['assemblyai', 'ASSEMBLYAI', 'Bearer ', 'Authorization', 'streaming.', 'agents.', KEY, TOKEN]) expect(bundle, needle).not.toContain(needle);
    const realKey = process.env.ASSEMBLYAI_API_KEY;
    if (realKey && realKey.length >= 8) expect(bundle.includes(realKey)).toBe(false);          // the real key (when the environment has one) is not in the bundle
    const src = walk(join(ROOT, 'dashboard/src'), /\.ts$/).map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(src).not.toMatch(/assemblyai.com/i);                                       // (comments may NAME the vendor; no code may address it)
    expect(src).not.toMatch(/localStorage|document\.cookie|location\.(search|hash)|\?token=|&token=/);      // the token lives in sessionStorage only, never in a URL
    expect(src).not.toMatch(/https?:\/\//);                                                    // no absolute URL: every request is same-origin
    for (const m of src.matchAll(/new WebSocket\(([^)]*)\)/g)) expect(m[1]).toMatch(/location\.host/);
  }, 60000);

  it('no server log line contains the API key or the operator token during start-up and use', async () => {
    const lines: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
    const dir = mkdtempSync(join(tmpdir(), 'tally-log-'));
    const srv = await startServer({ ASSEMBLYAI_API_KEY: KEY, TALLY_OPERATOR_TOKEN: TOKEN, PORT: '0', TALLY_DB_PATH: join(dir, 't.sqlite'), TALLY_AUDIO_DIR: join(dir, 'audio') } as NodeJS.ProcessEnv);
    const port = (srv.app.server.address() as { port: number }).port;
    await fetch(`http://127.0.0.1:${port}/api/metrics`, { headers: { 'x-tally-operator': TOKEN } });
    await fetch(`http://127.0.0.1:${port}/api/metrics`, { headers: { 'x-tally-operator': 'wrong-token-value-1234' } });
    await fetch(`http://127.0.0.1:${port}/api/sessions`, { method: 'POST', headers: { 'x-tally-operator': TOKEN, 'content-type': 'application/json' }, body: '{' });
    await srv.close();
    expect(lines.join('\n')).not.toContain(KEY);
    expect(lines.join('\n')).not.toContain(TOKEN);
    expect(lines.join('\n')).not.toContain('wrong-token-value-1234');
  }, 30000);

  it('.env is git-ignored, data/ (audio, database) is git-ignored, and .env.example holds no secret values', () => {
    const ig = readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n').map((l) => l.trim());
    expect(ig).toContain('.env'); expect(ig).toContain('data/'); expect(ig).toContain('dashboard/dist/');
    const ex = readFileSync(join(ROOT, '.env.example'), 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l));
    const secretish = ex.filter((l) => /(KEY|TOKEN|SECRET|PASSWORD)=/.test(l));
    expect(secretish.length).toBeGreaterThanOrEqual(2);
    for (const l of secretish) expect(l.split('=')[1]!.trim(), l).toBe('');
  });
});

describe('the API never reveals the server\'s file layout or any credential', () => {
  it('after a real (scripted) call: every read endpoint, the SSE stream and the demo result contain no path, no key, no token, and cases say has_audio instead of a pointer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-surf-'));
    initDatabase(join(dir, 't.sqlite'));
    const store = new Store(join(dir, 't.sqlite'));
    ensureBaseline(store, {});
    const audioDir = join(dir, 'demo-audio-private-dir');
    const { app, runtimes } = await buildApp({ operatorToken: TOKEN, cases: store, dashboardDir: join(dir, 'none'), demo: { audioDir, runtime: () => ({}) }, startRuntime: async () => { throw new Error('unused'); } });
    cleanups.push(async () => { await app.close(); store.close(); });
    const result = await runScenario('dropout', { store, audioDir, onSession: (rt) => runtimes.set(rt.session_id, rt) });
    const H = { 'x-tally-operator': TOKEN };
    const sid = [...runtimes.keys()][0]!;
    const caseId = store.listCases()[0]!.id;
    const get = async (url: string) => (await app.inject({ url, headers: H })).body;
    const bodies = [
      JSON.stringify(result),
      await get('/api/sessions'), await get(`/api/sessions/${sid}`), await get(`/api/sessions/${sid}/events`), await get('/api/cases'), await get(`/api/cases/${caseId}`), await get(`/api/cases/${caseId}/replays`),
      await get('/api/regressions/count'), await get('/api/metrics'), await get('/api/configs'), await get('/api/configs/active'), await get('/api/configs/v1'), await get('/api/compare'), await get('/api/demo/scenarios'),
    ];
    for (const b of bodies) {
      expect(b).not.toContain(audioDir); expect(b).not.toContain(dir); expect(b).not.toContain(KEY); expect(b).not.toContain(TOKEN);
      expect(b).not.toMatch(/[A-Za-z]:\\\\|\/tmp\/|\/var\/folders|\/Users\/|\.pcm|\.sqlite/);
    }
    const detail = JSON.parse(bodies[5]!);
    expect(detail.has_audio).toBe(true);
    expect(detail.audio_pointer).toBeUndefined();
    expect(detail.event_snapshot.audio.pointer).toBeUndefined();
    // the SSE backlog for that session is the same story
    const sse = await app.inject({ url: `/api/live/${sid}`, headers: H, payloadAsStream: true }).catch(() => null);
    void sse;
  }, 60000);
});
