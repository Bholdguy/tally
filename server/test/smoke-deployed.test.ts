// The deployment smoke test, tested: it must PASS against a healthy server started with its default configuration, and FAIL against the
// kinds of broken deployment that matter (the mic origin defect, a leaking bundle, an open API, wrong token). A smoke test that cannot fail is not one.
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { runSmoke } from '../../scripts/lib/smoke.js';
import { startServer } from '../src/main.js';

const run = promisify(execFile);
const TOKEN = ['smoke', 'token', '0123456789abcd'].join('-');
const KEY = ['k', 'smoke', 'test', 'key', '0000000'].join('-');
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function healthy() {
  const dir = mkdtempSync(join(tmpdir(), 'tally-smoke-'));
  const srv = await startServer({ ASSEMBLYAI_API_KEY: KEY, TALLY_OPERATOR_TOKEN: TOKEN, PORT: '0', TALLY_DB_PATH: join(dir, 't.sqlite'), TALLY_AUDIO_DIR: join(dir, 'a') } as NodeJS.ProcessEnv);
  cleanups.push(() => srv.close());
  return { srv, url: `http://127.0.0.1:${(srv.app.server.address() as { port: number }).port}` };
}
const failing = (r: { checks: { name: string; ok: boolean }[] }) => r.checks.filter((c) => !c.ok).map((c) => c.name);

describe('smoke test against a healthy server started with DEFAULT configuration', () => {
  it('passes every check: dashboard, security headers, API closed/open, mic origin, scenarios identical to a fresh local run, stored case, deterministic replay, adversarial harness', async () => {
    const { url } = await healthy();
    const r = await runSmoke(url, TOKEN, { scenarios: ['dropout', 'confidence'], adversarial: true, secretToScan: KEY });
    expect(failing(r)).toEqual([]);
    expect(r.ok).toBe(true);
    const names = r.checks.map((c) => c.name).join('\n');
    for (const needle of ['mic socket accepts the page\'s OWN origin', 'mic socket refuses a foreign origin', 'scenario dropout is IDENTICAL to a fresh local run', 'scenario confidence is IDENTICAL to a fresh local run', 'byte-identical deterministic result', 'adversarial harness on the target']) expect(names, needle).toContain(needle);
    expect(r.checks.length).toBeGreaterThan(25);
  }, 180000);

  it('--dry writes nothing to the target', async () => {
    const { srv, url } = await healthy();
    const r = await runSmoke(url, TOKEN, { dry: true });
    expect(failing(r)).toEqual([]);
    expect(srv.store.listSessions()).toEqual([]);
    expect(srv.store.listCases()).toEqual([]);
  }, 60000);

  it('the CLI exits 0, never prints the token, and exits 2 on bad usage', async () => {
    const { url } = await healthy();
    const ok = await run('npx', ['tsx', 'scripts/smoke-deployed.ts', url, TOKEN, '--dry'], { cwd: process.cwd(), shell: true, timeout: 90000 });
    expect(ok.stdout).toMatch(/checks passed/);
    expect(ok.stdout + ok.stderr).not.toContain(TOKEN);
    await expect(run('npx', ['tsx', 'scripts/smoke-deployed.ts', 'not-a-url', TOKEN], { cwd: process.cwd(), shell: true, timeout: 60000 })).rejects.toMatchObject({ code: 2 });
    await expect(run('npx', ['tsx', 'scripts/smoke-deployed.ts', url, TOKEN, '--scenarios=Z'], { cwd: process.cwd(), shell: true, timeout: 60000 })).rejects.toMatchObject({ code: 2 });
  }, 180000);
});

describe('smoke test against BROKEN deployments fails, and says which check', () => {
  it('a wrong operator token fails the authenticated checks', async () => {
    const { url } = await healthy();
    const r = await runSmoke(url, `${TOKEN}-wrong`, { dry: true });
    expect(r.ok).toBe(false);
    expect(failing(r).join(' | ')).toMatch(/authenticated|active config|metrics|sessions endpoint|demo banner/i);
  }, 60000);

  it('a deployment that refuses the page\'s own origin on the mic socket (the original defect), serves a bundle containing the token, and leaves the API open', async () => {
    const stub: Server = createServer((req, res) => {
      const csp = "default-src 'none'; script-src 'self'; style-src 'self'";
      if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }
      else if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': csp, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }); res.end('<script src="/app.js"></script>'); }
      else if (req.url === '/app.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(`const t="${TOKEN}"`); }
      else if (req.url === '/style.css') { res.writeHead(200, { 'content-type': 'text/css' }); res.end('body{}'); }
      else if (req.url === '/api/metrics') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"generated_from":"stored rows"}'); }     // NO auth check
      else { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'boom', stack: 'at Object.<anonymous> (C:\srv\app.ts:1:1)' })); }
    });
    stub.on('upgrade', (_req, socket) => { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise<void>((r) => stub.close(() => r())));
    const url = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;
    const r = await runSmoke(url, TOKEN, { dry: true });
    const f = failing(r).join(' | ');
    expect(r.ok).toBe(false);
    expect(f).toContain('mic socket accepts the page\'s OWN origin');
    expect(f).toContain('served script contains no operator token');
    expect(f).toContain('API is closed without the token');
    expect(f).toContain('leak no path or stack');
  }, 60000);

  it('an unreachable URL fails cleanly (no hang, no throw)', async () => {
    const r = await runSmoke('http://127.0.0.1:1', TOKEN, { dry: true });
    expect(r.ok).toBe(false);
    expect(r.checks.some((c) => !c.ok)).toBe(true);
  }, 60000);
});
