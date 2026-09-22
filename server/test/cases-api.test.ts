// Step 7 API: cases and regression counters. Read-only except operator acceptance, which can only tag an existing resolved candidate.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initDatabase } from '@tally/db';
import { Store } from '@tally/reliability';
import { buildApp } from '../src/app.js';

const TOKEN = ['operator', 'token', '0123456789'].join('-');
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'tally-cases-'));
  initDatabase(join(dir, 't.sqlite'));
  const store = new Store(join(dir, 't.sqlite'));
  store.createSession({ id: 's1', mode: 'demo', config_version: 'v1' });
  store.openOrder('s1');
  const pcm = join(dir, 's1.pcm'); writeFileSync(pcm, Buffer.alloc(4800)); store.setAudioPointer('s1', pcm);
  store.insertEventRaw({ id: 'e1', session_id: 's1', direction: 'in', type: 'evidence_transcript', payload: { kind: 'evidence_transcript', text: 'three burgers' }, t_ms: 1 });
  const hold = (id: string) => store.recordHold({
    session_id: 's1', aai_call_id: id, tool: 'add_item', args: { item_id: 'burger', quantity: 2 }, execution_mode: 'hold', status: 'conflict', code: 'QTY_MISMATCH', detail: 'd', evidence: {}, validation_event_id: `v${id}`,
    repair: { scope: 'burger', attempt: 1, prompt: 'p', outcome: 'pending' }, case: { pattern_key: 'QTY_MISMATCH|add_item|plain_statement|na', threshold: 3, audio_exists: true, up_to_ms: 10 },
  });
  const { app } = await buildApp({ operatorToken: TOKEN, cases: store, startRuntime: async () => { throw new Error('unused'); } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  cleanups.push(async () => { await app.close(); store.close(); });
  const H = { 'x-tally-operator': TOKEN };
  return { store, hold, base, H };
}

describe('cases API', () => {
  it('reads are open to a guest (no token); accepting a regression is operator-only (403 for a guest)', async () => {
    const { base } = await setup();
    for (const p of ['/api/cases', '/api/regressions/count']) expect((await fetch(base + p)).status).toBe(200);
    expect((await fetch(`${base}/api/cases/x`)).status).toBe(404);           // a guest read of an unknown case: 404, not an auth error
    expect((await fetch(`${base}/api/cases/x/accept`, { method: 'POST' })).status).toBe(403);
  });

  it('lists cases, counts, and flips the regression counters on the third repeat', async () => {
    const { hold, base, H } = await setup();
    hold('a'); hold('b');
    expect(await (await fetch(`${base}/api/regressions/count`, { headers: H })).json()).toMatchObject({ cases: 2, candidates: 0, patterns_flipped: 0 });
    hold('c');
    expect(await (await fetch(`${base}/api/regressions/count`, { headers: H })).json()).toMatchObject({ cases: 3, candidates: 3, patterns_flipped: 1 });
    const list = await (await fetch(`${base}/api/cases?tag=regression_candidate`, { headers: H })).json() as { cases: { id: string }[] };
    expect(list.cases).toHaveLength(3);
    const one = await (await fetch(`${base}/api/cases/${list.cases[0]!.id}`, { headers: H })).json() as any;
    expect(one).toMatchObject({ conflict_type: 'QTY_MISMATCH', tag: 'regression_candidate', expected_state: null });
    expect(one.event_snapshot.events).toHaveLength(1);
    expect(one.event_snapshot_json).toBeUndefined();
    expect((await fetch(`${base}/api/cases/nope`, { headers: H })).status).toBe(404);
  });

  it('accept: an unresolved candidate is refused (409); a resolved one becomes a regression; nothing here writes an order', async () => {
    const { store, hold, base, H } = await setup();
    hold('a'); hold('b'); hold('c');
    const ids = store.listCases().map((c) => c.id);
    const post = (id: string) => fetch(`${base}/api/cases/${id}/accept`, { method: 'POST', headers: H });
    expect((await post(ids[0]!)).status).toBe(409);
    expect((await post('nope')).status).toBe(404);
    const before = JSON.stringify(store.getOrder('s1'));
    store.resolveRepairs('s1', ['burger']);
    expect((await post(ids[0]!)).status).toBe(200);
    expect(store.getCase(ids[0]!)).toMatchObject({ tag: 'regression', accepted_by: 'operator' });
    expect(JSON.stringify(store.getOrder('s1'))).toBe(before);
  });
});
