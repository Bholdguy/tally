// Finished sessions must leave memory (and the "active" list) while their stored data stays readable.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Secret } from '@tally/agent';
import { initDatabase } from '@tally/db';
import { Store } from '@tally/reliability';
import { buildApp } from '../src/app.js';
import { SessionRuntime } from '../src/runtime.js';
import { mockAgent, mockStt, wait } from './mocks.js';

const TOKEN = ['operator', 'token', '0123456789'].join('-');
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function world(endedGraceMs: number) {
  const agent = await mockAgent(); const stt = await mockStt();
  const dir = mkdtempSync(join(tmpdir(), 'tally-evict-'));
  initDatabase(join(dir, 't.sqlite'));
  const store = new Store(join(dir, 't.sqlite'));
  const { app, runtimes } = await buildApp({
    operatorToken: TOKEN, cases: store, endedGraceMs,
    startRuntime: () => SessionRuntime.start({ agentConfig: { apiKey: new Secret('k-0000000'), wsUrl: agent.url, restUrl: 'http://x' }, store, audioDir: join(dir, 'audio'), mode: 'live', stt: { url: stt.url } }),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  cleanups.push(async () => { await app.close(); store.close(); await agent.close(); await stt.close(); });
  const H = { 'x-tally-operator': TOKEN, 'content-type': 'application/json' };
  const j = async (path: string, init: RequestInit = {}) => (await fetch(base + path, { headers: H, ...init })).json() as Promise<any>;
  return { runtimes, base, H, j, start: async () => (await j('/api/sessions', { method: 'POST', body: '{}' })).session_id as string };
}

describe('ended sessions are evicted from memory; the active list is accurate', () => {
  it('a finished session leaves the ACTIVE list immediately, stays attachable for the grace period, then leaves memory; its stored events remain readable', async () => {
    const w = await world(150);
    const id = await w.start();
    expect((await w.j('/api/sessions')).active).toEqual([id]);
    await w.j(`/api/sessions/${id}/end`, { method: 'POST' });
    expect((await w.j('/api/sessions')).active).toEqual([]);                          // not "active" any more...
    expect(w.runtimes.has(id)).toBe(true);                                            // ...but a late live-stream client can still attach for a moment
    expect((await fetch(`${w.base}/api/live/${id}`, { headers: { 'x-tally-operator': TOKEN } })).status).toBe(200);
    await wait(300);
    await w.j('/api/sessions');                                                       // any API request prunes
    expect(w.runtimes.has(id)).toBe(false);
    expect((await fetch(`${w.base}/api/live/${id}`, { headers: { 'x-tally-operator': TOKEN } })).status).toBe(404);
    const stored = await w.j(`/api/sessions/${id}/events`);
    expect(stored.events.some((e: any) => e.kind === 'session_ended')).toBe(true);    // the database still has the whole call
    expect((await w.j('/api/sessions')).sessions.some((s: any) => s.id === id && s.ended_at)).toBe(true);
  });

  it('many sessions do not accumulate: after they end and the grace passes, memory holds none; a live one is never evicted', async () => {
    const w = await world(50);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await w.start());
    const keep = await w.start();
    for (const id of ids) await w.j(`/api/sessions/${id}/end`, { method: 'POST' });
    await wait(150);
    const list = await w.j('/api/sessions');
    expect(list.active).toEqual([keep]);
    expect([...w.runtimes.keys()]).toEqual([keep]);
  });
});
