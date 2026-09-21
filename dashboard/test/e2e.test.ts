// END TO END through the UI: the dashboard code (mounted into a jsdom document) talks over REAL HTTP and a REAL SSE stream to the real
// server (buildApp), which plays the deterministic scenarios through the real pipeline. What the operator would SEE is asserted:
// the badge sequence, the waiting chip, the barge-in marker, the REPAIR line, the order panel, the counters, the stored case.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { initDatabase } from '@tally/db';
import { Store } from '@tally/reliability';
import { buildApp } from '../../server/src/app.js';
import { ensureBaseline } from '../../server/src/bootstrap.js';
import { createApi } from '../src/api.js';
import { mountApp } from '../src/main.js';

const TOKEN = ['operator', 'token', '0123456789'].join('-');
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'tally-e2e-'));
  initDatabase(join(dir, 't.sqlite'));
  const store = new Store(join(dir, 't.sqlite'));
  ensureBaseline(store, {});
  const { app } = await buildApp({ operatorToken: TOKEN, cases: store, demo: { audioDir: join(dir, 'demo-audio'), runtime: () => ({}) }, startRuntime: async () => { throw new Error('no live agent'); } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const dom = new JSDOM('<!doctype html><div id="app"></div>', { url: 'http://localhost/' });
  const root = dom.window.document.getElementById('app') as HTMLElement;
  const ui = mountApp(root, { api: createApi(() => TOKEN, base), token: { get: () => TOKEN, set: () => undefined, clear: () => undefined }, pollMs: 0 });
  cleanups.push(async () => { ui.destroy(); await app.close(); store.close(); dom.window.close(); });
  const text = (sel: string) => root.querySelector(sel)?.textContent ?? '';
  const log = () => [...root.querySelectorAll('#calllog li.log')].map((li) => li.textContent!.replace(/^\d+\.\ds /, ''));
  return { ui, root, text, log, store, base };
}
async function waitFor(f: () => boolean, ms = 30000): Promise<void> { const t = Date.now(); while (!f() && Date.now() - t < ms) await tick(50); if (!f()) throw new Error('timeout waiting for the UI'); }

describe('operator dashboard, end to end over HTTP + SSE', () => {
  it('scenario B: the operator sees the barge-in, the WAITING chip, CONFLICT, the REPAIR line, ALLOWED·REPAIRED, the $26.97 order and the case counter', async () => {
    const h = await boot();
    await h.ui.flush();
    expect(h.text('.banner')).toMatch(/DETERMINISTIC DEMO/);
    (h.root.querySelector('[data-action="demo"][data-arg="B"]') as HTMLElement).click();

    // beat 5b: while the gate is waiting the chip is on screen, with a live countdown against the 4.0 s budget
    let sawWaiting = ''; let sawBarge = false;
    await waitFor(() => { const c = h.root.querySelector('#wait-chip'); if (c) sawWaiting ||= c.textContent ?? ''; if (h.root.querySelectorAll('svg.timeline .barge').length) sawBarge = true; return /ALLOWED · REPAIRED/.test(h.log().join('\n')); }, 60000);
    await h.ui.flush(); await tick(300); await h.ui.flush();
    expect(sawWaiting).toMatch(/WAITING ON INDEPENDENT EVIDENCE/);
    expect(sawWaiting).toMatch(/\/ 4\.0 s/);
    expect(sawBarge).toBe(true);

    const log = h.log();
    const verdicts = log.filter((l) => /^(CONFLICT|ALLOWED)/.test(l));
    expect(verdicts[0]).toMatch(/^CONFLICT QTY_MISMATCH add_item classic burger ×2 · held \d\.\d s waiting for evidence/);
    expect(verdicts[1]).toMatch(/^ALLOWED · REPAIRED add_item classic burger ×3/);
    expect(log).toContain('REPAIR: "Just to confirm, that\'s 3 classic burgers?"');
    expect(h.text('#order')).toContain('3 classic burgers');
    expect(h.text('#order')).toContain('$26.97');
    expect(h.root.querySelector('#wait-chip')).toBeNull();
    await waitFor(() => /1/.test(h.text('#cnt-cases')), 10000);                    // the counter came from the server's stored rows
    expect(h.store.listCases()).toHaveLength(1);

    // the stored case, opened through the Cases tab, in words
    (h.root.querySelector('[data-action="tab"][data-arg="cases"]') as HTMLElement).click();
    await waitFor(() => !!h.root.querySelector('[data-action="case"]'), 10000);
    (h.root.querySelector('[data-action="case"]') as HTMLElement).click();
    await waitFor(() => !!h.root.querySelector('#case-detail'), 10000);
    expect(h.text('#case-detail')).toContain('3 classic burgers');
    // replay it from the UI: deterministic PASS with a diff
    (h.root.querySelector('[data-action="replay-evidence"]') as HTMLElement).click();
    await waitFor(() => !!h.root.querySelector('#diff'), 20000);
    expect(h.text('#diff')).toMatch(/PASS \(deterministic\)/);
    expect(h.text('#diff')).toMatch(/still_held/);
  }, 120000);

  it('scenario dropout: the stream-down chip and HELD UNVALIDATABLE appear, and the order stays empty', async () => {
    const h = await boot();
    await h.ui.flush();
    (h.root.querySelector('[data-action="demo"][data-arg="dropout"]') as HTMLElement).click();
    await waitFor(() => /HELD UNVALIDATABLE/.test(h.log().join('\n')), 30000);
    await h.ui.flush(); await tick(200);
    expect(h.text('#wait-chip')).toMatch(/EVIDENCE STREAM DOWN .* HELD \(fail closed\)/);
    expect(h.text('#order')).toMatch(/nothing yet/);
  }, 60000);
});
