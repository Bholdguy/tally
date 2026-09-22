// Step 9 API: configs, "run all cases", promotion, rollback. The API only REQUESTS; the data layer decides.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '@tally/agent';
import { toolDeclarations } from '@tally/contract';
import { sha256 } from '@tally/reliability';
import { makeRig } from '../../reliability/test/rig.js';
import { buildApp } from '../src/app.js';
import { startServer } from '../src/main.js';

const TOKEN = ['operator', 'token', '0123456789'].join('-');
const KEY = ['k', 'secret', 'api', 'key', '0000000'].join('-');
const PROMPT = 'You are the voice ordering assistant. Keep replies short and natural.';
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const B = (q: number) => ({ item_id: 'burger', quantity: q, modifiers: [] as string[] });

/** A store with baseline v1 active and one accepted regression case (a misheard quantity: the confidence check protects it). */
async function api(over: Partial<Parameters<typeof buildApp>[0]> = {}) {
  const r = makeRig({ persist: true, regressionThreshold: 1 });
  r.store.createConfig({ version: 'v1', prompt_text: PROMPT, tool_schema_json: JSON.stringify(toolDeclarations()) });
  r.store.activateBaseline('v1');
  r.up(); r.final('two burgers.', { conf: 0.4 });
  await r.call('add_item', B(2));
  const caseId = r.store.listCases()[0]!.id;
  r.clock.advance(500); r.final('three burgers.', { conf: 0.9 });
  await r.call('add_item', B(3));
  expect(r.store.acceptRegression(caseId, 'operator')).toEqual({ ok: true });
  const { app } = await buildApp({ operatorToken: TOKEN, cases: r.store, replaySettleMs: 50, startRuntime: async () => { throw new Error('no live agent in this test'); }, ...over });
  await app.listen({ host: '127.0.0.1', port: 0 });
  cleanups.push(async () => { await app.close(); r.close(); });
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const H = { 'x-tally-operator': TOKEN, 'content-type': 'application/json' };
  const post = (path: string, body?: unknown) => fetch(base + path, { method: 'POST', headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  const get = (path: string) => fetch(base + path, { headers: H });
  return { r, caseId, base, H, post, get };
}
const json = async (res: Response) => (await res.json()) as any;

describe('auth and registry', () => {
  it('GET routes are open to a guest (D-39); every mutating route (create/run/promote/rollback) is operator-only, 403 for a guest', async () => {
    const { base } = await api();
    for (const [m, p] of [['GET', '/api/configs'], ['GET', '/api/configs/active'], ['GET', '/api/configs/v1'], ['GET', '/api/suite/x'], ['GET', '/api/compare']] as const) {
      expect((await fetch(base + p, { method: m })).status, `${m} ${p}`).not.toBe(401);
      expect((await fetch(base + p, { method: m })).status, `${m} ${p}`).not.toBe(403);
    }
    for (const [m, p] of [['POST', '/api/configs'], ['POST', '/api/suite/run'], ['POST', '/api/configs/v1/promote'], ['POST', '/api/configs/rollback']] as const) {
      expect((await fetch(base + p, { method: m })).status, `${m} ${p}`).toBe(403);
    }
  });

  it('create: hashes returned; the tool schema is ALWAYS the contract\'s (a body cannot weaken hold mode); duplicates rejected (never overwritten); bad input 400', async () => {
    const { post, get } = await api();
    const res = await post('/api/configs', { version: 'v2', prompt_text: `${PROMPT} Say hello.`, gating_params: { evidenceWaitMaxMs: 3500 }, tool_schema_json: '[]' });
    expect(res.status).toBe(201);
    const c = await json(res);
    expect(c).toMatchObject({ version: 'v2', parent_version: 'v1', promoted: false, gating_params: { evidenceWaitMaxMs: 3500 } });
    expect(c.tool_schema_hash).toBe(sha256(JSON.stringify(toolDeclarations())));       // the '[]' in the body was ignored
    const dup = await post('/api/configs', { version: 'v2', prompt_text: `${PROMPT} Something else entirely.` });
    expect(dup.status).toBe(409);
    expect(await json(dup)).toMatchObject({ error: 'CONFIG_EXISTS' });
    expect((await json(await get('/api/configs/v2'))).prompt_text).toBe(`${PROMPT} Say hello.`);   // still the original
    expect((await post('/api/configs', { version: 'v9', prompt_text: 'x' })).status).toBe(400);
    expect((await post('/api/configs', { version: 'v9', prompt_text: PROMPT, gating_params: { minWordConfidence: 5 } })).status).toBe(400);
    const list = await json(await get('/api/configs'));
    expect(list.configs.map((x: any) => [x.version, x.active])).toEqual([['v1', true], ['v2', false]]);
    expect((await json(await get('/api/configs/active'))).version).toBe('v1');
    expect((await get('/api/configs/nope')).status).toBe(404);
  });
});

describe('run all cases, then promote or be blocked', () => {
  it('a PASSING config: suite passes (with the validation notice), promotes, becomes active; the same run cannot promote twice', async () => {
    const { post, get } = await api();
    await post('/api/configs', { version: 'v2', prompt_text: `${PROMPT} Say hello.`, gating_params: { evidenceWaitMaxMs: 3500 } });
    // v2 changes the PROMPT: the evidence tier cannot see that, so without the audio tier the suite blocks (see below); v3 changes gating only
    await post('/api/configs', { version: 'v3', prompt_text: PROMPT, gating_params: { evidenceWaitMaxMs: 3500 }, parent_version: 'v1' });
    const run = await post('/api/suite/run', { config_version: 'v3' });
    expect(run.status).toBe(200);
    const rep = await json(run);
    expect(rep).toMatchObject({ status: 'passed', suite_size: 1, vacuous: false, label: 'PASSED 1/1 regression cases', audio: { ran: false, required: false } });
    expect(rep.validation_notice).toMatch(/SYNTHETIC and CAPTURED phrasing only/);
    expect(rep.guarantees.join(' ')).toMatch(/audio tier: NOT run/);
    const pr = await post('/api/configs/v3/promote', { suite_run_id: rep.suite_run_id });
    expect(pr.status).toBe(200);
    expect(await json(pr)).toMatchObject({ promoted: 'v3', previous: 'v1' });
    expect((await json(await get('/api/configs/active'))).version).toBe('v3');
    const again = await post('/api/configs/v3/promote', { suite_run_id: rep.suite_run_id });
    expect(again.status).toBe(409);                                                     // already active
    const pr2 = await post('/api/configs/v2/promote', { suite_run_id: rep.suite_run_id });
    expect(pr2.status).toBe(409);
    expect(await json(pr2)).toMatchObject({ error: 'SUITE_MISMATCH' });
  });

  it('a config that BREAKS a previously-passing case is BLOCKED: suite names the case, promotion is refused (409) and names it again, active unchanged', async () => {
    const { post, get, caseId } = await api();
    await post('/api/configs', { version: 'v4', prompt_text: PROMPT, gating_params: { minWordConfidence: 0.1 } });
    const rep = await json(await post('/api/suite/run', { config_version: 'v4' }));
    expect(rep.status).toBe('blocked');
    expect(rep.blocking).toEqual([expect.objectContaining({ case_id: caseId, tier: 'evidence', reason: 'SAFETY_REGRESSION_now_allowed_but_must_be_held' })]);
    const pr = await post('/api/configs/v4/promote', { suite_run_id: rep.suite_run_id });
    expect(pr.status).toBe(409);
    const body = await json(pr);
    expect(body).toMatchObject({ error: 'SUITE_NOT_PASSED' });
    expect(body.blocking[0].case_id).toBe(caseId);
    expect(body.validation_notice).toMatch(/real-speech/);
    expect((await post('/api/configs/v4/promote')).status).toBe(409);                    // no suite run at all
    expect((await json(await get('/api/configs/active'))).version).toBe('v1');
    // the stored run can be read back by its id
    expect(await json(await get(`/api/suite/${rep.suite_run_id}`))).toMatchObject({ status: 'blocked', config_version: 'v4' });
  });

  it('a PROMPT change needs the audio tier: evidence-only is blocked with AUDIO_TIER_REQUIRED; with audio (async job) the failing live runs block and name the case', async () => {
    const { post, get, caseId } = await api();
    await post('/api/configs', { version: 'v5', prompt_text: `${PROMPT} Always repeat the quantity back.` });
    const rep = await json(await post('/api/suite/run', { config_version: 'v5' }));
    expect(rep.status).toBe('blocked');
    expect(rep.blocking[0]).toMatchObject({ tier: 'audio', reason: 'AUDIO_TIER_REQUIRED' });

    const started = await post('/api/suite/run', { config_version: 'v5', audio: true, k: 3 });
    expect(started.status).toBe(202);
    const { job_id } = await json(started);
    let job: any;
    for (let i = 0; i < 100; i++) { job = await json(await get(`/api/suite/${job_id}`)); if (job.status !== 'running') break; await new Promise((r) => setTimeout(r, 100)); }
    expect(job.status).toBe('done');
    expect(job.report.status).toBe('blocked');                                            // no live agent here: every attempt failed, and none was hidden
    expect(job.report.blocking).toEqual([expect.objectContaining({ case_id: caseId, tier: 'audio', reason: 'AUDIO_0_OF_3_PASSED' })]);
    expect(job.report.cases[0].audio).toBe('0/3 passed: FAIL');
  }, 30000);

  it('rollback re-activates the parent; a second rollback has nothing to return to; compare table lists cases x versions', async () => {
    const { post, get, caseId } = await api();
    await post('/api/configs', { version: 'v3', prompt_text: PROMPT, gating_params: { evidenceWaitMaxMs: 3500 } });
    await post('/api/configs', { version: 'v4', prompt_text: PROMPT, gating_params: { minWordConfidence: 0.1 } });
    const ok = await json(await post('/api/suite/run', { config_version: 'v3' }));
    await json(await post('/api/suite/run', { config_version: 'v4' }));
    expect((await post('/api/configs/v3/promote', { suite_run_id: ok.suite_run_id })).status).toBe(200);
    expect(await json(await post('/api/configs/rollback'))).toEqual({ from: 'v3', to: 'v1' });
    expect((await json(await get('/api/configs/active'))).version).toBe('v1');
    const again = await post('/api/configs/rollback');
    expect(again.status).toBe(409);
    expect(await json(again)).toMatchObject({ error: 'NOTHING_TO_ROLL_BACK' });
    const t = await json(await get('/api/compare'));
    expect(t.table.find((x: any) => x.case_id === caseId).by_version).toMatchObject({ v3: { evidence: 'pass' }, v4: { evidence: 'fail' } });
    expect((await json(await get('/api/configs/v3'))).history.map((h: any) => h.action)).toEqual(['create', 'promote']);
  });

  it('unknown config / bad body are handled without a crash', async () => {
    const { post } = await api();
    expect((await post('/api/suite/run', { config_version: 'nope' })).status).toBe(404);
    expect((await post('/api/configs/nope/promote', { suite_run_id: 'x' })).status).toBe(404);
  });
});

describe('startup', () => {
  it('startServer creates and activates the baseline v1 from this build\'s prompt and gating settings, once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-boot-'));
    const env = { ASSEMBLYAI_API_KEY: KEY, TALLY_OPERATOR_TOKEN: TOKEN, PORT: '0', TALLY_DB_PATH: join(dir, 't.sqlite'), TALLY_AUDIO_DIR: join(dir, 'audio'), REGRESSION_THRESHOLD: '4' } as NodeJS.ProcessEnv;
    const srv = await startServer(env);
    const v1 = srv.store.activeConfig()!;
    expect(v1).toMatchObject({ version: 'v1', prompt_text: buildSystemPrompt(), integrity_ok: true });
    expect(v1.gating_params).toMatchObject({ evidenceWaitMaxMs: 4000, minWordConfidence: 0.6, regressionThreshold: 4 });
    await srv.close();
    const srv2 = await startServer(env);                                                   // a restart does not re-create or re-activate anything
    expect(srv2.store.listConfigs()).toHaveLength(1);
    expect(srv2.store.configHistory().map((e) => e.action)).toEqual(['create', 'baseline']);
    await srv2.close();
  });
});
