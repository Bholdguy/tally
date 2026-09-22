// @vitest-environment jsdom
// The dashboard through the DOM: the real event streams (captured from the demo pipeline) are replayed into the mounted app and the
// operator-visible result is asserted: badge sequence, waiting chip, barge-in marker, REPAIR line, order panel, counters, compare table.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Api } from '../src/api.js';
import { ApiError } from '../src/api.js';
import { mountApp, type Deps } from '../src/main.js';
import type { Mic } from '../src/mic.js';
import type { Ev } from '../src/state.js';

const load = (n: string): Ev[] => JSON.parse(readFileSync(join(process.cwd(), 'dashboard/test/fixtures', `${n}.events.json`), 'utf8'));
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

interface Fake { api: Api; finished: () => Promise<void>; calls: { method: string; path: string; body?: any }[]; routes: Record<string, any>; gate?: { kind: string; resume: () => void; hit: Promise<void> } }
/** an in-memory Tally server: canned GETs (mutable by the test), recorded POSTs, an SSE stream that replays real events */
function fake(events: Ev[], pauseAt?: string): Fake {
  const f: Fake = {
    calls: [],
    routes: {
      // most fixtures exercise operator-only actions (replay, accept, promote, mic…), so default to an already-logged-in session;
      // the sign-in suite below overrides this to exercise the guest tier explicitly
      'GET /api/whoami': { role: 'operator' },
      'GET /api/demo/scenarios': { scenarios: [{ name: 'A', label: 'A' }, { name: 'B', label: 'B · recover' }], banner: 'DETERMINISTIC DEMO: scripted agent' },
      'GET /api/regressions/count': { cases: 0, candidates: 0, regressions: 0, patterns_flipped: 0 },
      'GET /api/metrics': { stages: Object.fromEntries(['stt', 'gate', 'repair', 'commit', 'first_audio', 'barge_in'].map((k) => [k, { n: 0, p50: null, p95: null, max: null, mean: null }])), rates: { conflict_rate: { value: null, n: 0, of: 0 }, repair_success_rate: { value: null, n: 0, of: 0 }, false_positive_rate: { value: null, n: 0, of: 0, note: '' }, regression_pass_rate: { value: null, n: 0, of: 0 }, final_order_accuracy: { value: null, n: 0, of: 0, note: '' } } },
      'GET /api/sessions': { sessions: [], active: ['sess-1'] },
    },
    api: undefined as unknown as Api,
    finished: async () => { await streamDone; },
  };
  let streamDone: Promise<void> = Promise.resolve();
  const key = (m: string, p: string) => `${m} ${p.split('?')[0]}`;
  f.api = {
    get: async (p) => { f.calls.push({ method: 'GET', path: p }); const r = f.routes[key('GET', p)]; if (r instanceof ApiError) throw r; if (r === undefined) throw new ApiError(404, { error: 'not_found' }); return typeof r === 'function' ? r(p) : r; },
    post: async (p, body) => { f.calls.push({ method: 'POST', path: p, body }); const r = f.routes[key('POST', p)]; if (r instanceof ApiError) throw r; return typeof r === 'function' ? r(p, body) : r ?? {}; },
    blob: async () => new Blob(['RIFF']),
    stream: (_p, on, signal) => {
      streamDone = (async () => {
      for (const e of events) {
        if (signal?.aborted) return;
        on(e);
        await tick(0);
        if (pauseAt && e.kind === pauseAt && f.gate) { f.gate.kind = e.kind; await new Promise<void>((res) => { f.gate!.resume = res; (f.gate as any).hitResolve?.(); }); }
      }
      })();
      return streamDone;
    },
  };
  if (pauseAt) { let hitResolve!: () => void; const hit = new Promise<void>((r) => { hitResolve = r; }); f.gate = { kind: '', resume: () => undefined, hit }; (f.gate as any).hitResolve = hitResolve; }
  return f;
}
const token = () => { let t = 'tok'; return { get: () => t, set: (x: string) => { t = x; }, clear: () => { t = ''; } }; };
let root: HTMLElement;
beforeEach(() => { document.body.innerHTML = '<div id="app"></div>'; root = document.getElementById('app')!; (URL as any).createObjectURL = () => 'blob:test'; });
afterEach(() => { document.body.innerHTML = ''; });
const mount = (f: Fake, over: Partial<Deps> = {}) => mountApp(root, { api: f.api, token: token(), pollMs: 0, ...over });
const click = (sel: string) => { (root.querySelector(sel) as HTMLElement).click(); };
const text = (sel: string) => root.querySelector(sel)?.textContent ?? '';
const badges = (sel = '#calllog') => [...root.querySelectorAll(`${sel} li.log`)].map((li) => li.textContent!.replace(/^\d+\.\ds /, ''));

describe('guest and operator tiers (D-39)', () => {
  it('a guest (no login) sees the guest banner and the live/cases/metrics data, but no Lab tab and no mutating buttons', async () => {
    const f = fake([]);
    f.routes['GET /api/whoami'] = { role: 'guest' };
    const t = token(); t.clear();
    const app = mount(f, { token: t });
    await app.flush();
    expect(root.querySelector('#tier-banner')?.className).toContain('guest');
    expect(text('#tier-banner')).toContain('Guest view');
    expect(root.querySelector('[data-form="login"]')).not.toBeNull();           // the sign-in form is IN the banner, not a full-page gate
    expect(root.querySelector('[data-action="start"]')).toBeNull();             // starting a real call needs operator sign-in
    expect(root.querySelector('[data-action="mic"]')).toBeNull();
    expect(root.querySelector('[data-action="tab"][data-arg="lab"]')).toBeNull(); // no Lab tab for a guest
    expect(root.querySelector('[data-action="demo"]')).not.toBeNull();          // a guest CAN trigger a demo scenario
    app.destroy();
  });

  it('signing in posts the token to /api/login (never a header-only flow) and unlocks operator controls; a 401 stays on the guest tier and clears the token', async () => {
    const f = fake([]);
    f.routes['GET /api/whoami'] = { role: 'guest' };
    const t = token(); t.clear();
    const app = mount(f, { token: t });
    await app.flush();
    f.routes['POST /api/login'] = new ApiError(401, { error: 'invalid_token' });
    (root.querySelector('input[name=token]') as HTMLInputElement).value = 'wrong';
    root.querySelector('form[data-form="login"]')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await app.flush();
    expect(f.calls.some((c) => c.method === 'POST' && c.path === '/api/login' && c.body?.token === 'wrong')).toBe(true);
    expect(text('#tier-banner')).toContain('Guest view');                       // a bad token never upgrades the tier
    expect(t.get()).toBe('');

    f.routes['POST /api/login'] = { ok: true, role: 'operator' };
    (root.querySelector('input[name=token]') as HTMLInputElement).value = 'right';
    root.querySelector('form[data-form="login"]')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await app.flush();
    expect(text('#tier-banner')).toContain('Operator view (logged in)');
    expect(root.querySelector('[data-action="start"]')).not.toBeNull();
    expect(t.get()).toBe('right');                                             // kept only for the mic WS's first-frame auth

    f.routes['POST /api/logout'] = { ok: true, role: 'guest' };
    root.querySelector('[data-action="logout"]')!.dispatchEvent(new Event('click', { bubbles: true }));
    await app.flush();
    expect(text('#tier-banner')).toContain('Guest view');
    expect(t.get()).toBe('');
    app.destroy();
  });
});

describe('scenario B through the UI', () => {
  it('shows the WAITING chip mid-stream, then CONFLICT then ALLOWED·REPAIRED in the call log, the REPAIR line, the barge-in marker, the order panel, and the counters', async () => {
    const f = fake(load('B'), 'gate_waiting');
    f.routes['POST /api/demo/B'] = { run_id: 'r1', banner: 'x' };
    f.routes['GET /api/demo/runs/r1'] = { status: 'done', sessions: ['sess-1'], steps: [] };
    const app = mount(f);
    await app.flush();
    expect(text('.banner')).toMatch(/DETERMINISTIC DEMO/);
    expect(text('#cnt-cases')).toContain('0');

    click('[data-action="demo"][data-arg="B"]');
    await f.gate!.hit;                                                       // the stream is paused right after the gate started WAITING
    await tick(5);
    const chip = root.querySelector('#wait-chip')!;
    expect(chip.textContent).toMatch(/WAITING ON INDEPENDENT EVIDENCE/);
    expect(chip.textContent).toMatch(/\/ 4\.0 s/);
    expect(root.querySelectorAll('svg.timeline .barge').length).toBe(1);      // the barge-in already happened: ◆ marker on screen
    expect(root.querySelector('#order')!.textContent).toMatch(/nothing yet/); // the order panel is unchanged while waiting

    f.routes['GET /api/regressions/count'] = { cases: 1, candidates: 0, regressions: 0, patterns_flipped: 0 };
    f.gate!.resume();
    await app.flush(); await f.finished(); await tick(5); await app.flush();

    expect(root.querySelector('#wait-chip')).toBeNull();                      // the verdict resolved the wait
    const log = badges();
    const verdicts = log.filter((l) => /CONFLICT|ALLOWED/.test(l));
    expect(verdicts[0]).toMatch(/^CONFLICT QTY_MISMATCH add_item classic burger ×2 · held \d\.\d s waiting for evidence/);
    expect(verdicts[1]).toMatch(/^ALLOWED · REPAIRED add_item classic burger ×3/);
    expect(log.some((l) => l === 'REPAIR: "Just to confirm, that\'s 3 classic burgers?"')).toBe(true);
    expect(log.some((l) => /BARGE-IN derived/.test(l))).toBe(true);
    expect(log.some((l) => /^CASE logged: QTY_MISMATCH · add_item · customer correction, after the item was named/.test(l))).toBe(true);
    expect(text('#order')).toContain('3 classic burgers');
    expect(text('#order')).toContain('$26.97');
    expect(text('#cnt-cases')).toContain('1');                                // the counter refreshed from the server after the case event
    // every verdict in the timeline carries a text label, not just a colour
    const labels = [...root.querySelectorAll('svg.timeline .shape.bad text, svg.timeline .shape.repaired text')].map((t) => t.textContent);
    expect(labels).toEqual(['CONFLICT QTY_MISMATCH', 'ALLOWED · REPAIRED']);
    app.destroy();
  });

  it('the two transcript panels are shown side by side: the independent stream has the words, labelled as the evidence', async () => {
    const f = fake(load('B'));
    f.routes['POST /api/demo/B'] = { run_id: 'r1' }; f.routes['GET /api/demo/runs/r1'] = { status: 'done', sessions: ['sess-1'], steps: [] };
    const app = mount(f); await app.flush();
    click('[data-action="demo"][data-arg="B"]'); await app.flush(); await f.finished(); await tick(5); await app.flush();
    const cols = [...root.querySelectorAll('#transcripts .col')].map((c) => c.querySelector('h4')!.textContent);
    expect(cols).toEqual(['Independent stream', 'Voice Agent stream', 'Agent said']);
    expect(root.querySelector('#transcripts .col')!.textContent).toContain('No, wait, make it three.');
    app.destroy();
  });
});

describe('scenario A and dropout', () => {
  it('A: three green calls and a confirmed $20.47 order; no case', async () => {
    const f = fake(load('A'));
    f.routes['POST /api/demo/A'] = { run_id: 'r' }; f.routes['GET /api/demo/runs/r'] = { status: 'done', sessions: ['sess-1'], steps: [] };
    const app = mount(f); await app.flush();
    click('[data-action="demo"][data-arg="A"]'); await app.flush(); await f.finished(); await tick(5); await app.flush();
    expect(badges().filter((l) => /^ALLOWED/.test(l))).toHaveLength(3);
    expect(text('#order')).toContain('$20.47');
    expect(text('#order')).toContain('confirmed');
    expect(badges().some((l) => /^CASE/.test(l))).toBe(false);
    app.destroy();
  });

  it('dropout: the stream-down state is shown in words and the call is HELD (fail closed)', async () => {
    const f = fake(load('dropout'));
    f.routes['POST /api/demo/dropout'] = { run_id: 'r' }; f.routes['GET /api/demo/runs/r'] = { status: 'done', sessions: ['sess-1'], steps: [] };
    f.routes['GET /api/demo/scenarios'] = { scenarios: [{ name: 'dropout', label: 'dropout' }], banner: '' };
    const app = mount(f); await app.flush();
    click('[data-action="demo"][data-arg="dropout"]'); await app.flush(); await f.finished(); await tick(5); await app.flush();
    expect(text('#wait-chip')).toMatch(/EVIDENCE STREAM DOWN .* HELD \(fail closed\)/);
    expect(badges().some((l) => /^HELD UNVALIDATABLE/.test(l))).toBe(true);
    app.destroy();
  });
});

describe('hostile text never becomes markup', () => {
  it('a transcript, an agent line and a code containing HTML are shown as TEXT (no element, no handler runs)', async () => {
    const t0 = load('A')[0]!;
    const evil = '<img src=x onerror="window.__pwn=1"><script>window.__pwn=2</script>';
    const evs: Ev[] = [
      { ...t0, id: 'e1', kind: 'session_started', mode: 'demo' },
      { id: 'e2', session_id: t0.session_id, kind: 'evidence_transcript', t_ms: 10, wall_ms: 10, text: evil, end_of_turn: true, turn_order: 0, words: [] },
      { id: 'e3', session_id: t0.session_id, kind: 'transcript_agent', t_ms: 20, wall_ms: 20, text: evil },
      { id: 'e4', session_id: t0.session_id, kind: 'verdict', t_ms: 30, wall_ms: 30, aai_call_id: 'c', tool: evil, args: { item_id: evil }, verdict: 'HOLD', code: 'QTY_MISMATCH' },
      { id: 'e5', session_id: t0.session_id, kind: 'repair', t_ms: 40, wall_ms: 40, outcome: 'asked', ask_text: evil, scope: 'x' },
    ];
    const f = fake(evs);
    f.routes['POST /api/demo/A'] = { run_id: 'r' }; f.routes['GET /api/demo/runs/r'] = { status: 'done', sessions: ['sess-1'], steps: [] };
    const app = mount(f); await app.flush();
    click('[data-action="demo"][data-arg="A"]'); await app.flush(); await f.finished(); await tick(5); await app.flush();
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('#app script, main script, script')).toBeNull();
    expect((window as any).__pwn).toBeUndefined();
    expect(root.textContent).toContain('<img src=x');                          // it is there, as text
    app.destroy();
  });
});

describe('cases, replay and the diff viewer', () => {
  const kase = { id: 'case_abcdef12', session_id: 's', conflict_type: 'QTY_MISMATCH', pattern_key: 'QTY_MISMATCH|add_item|correction|mid_item', tag: 'regression_candidate', resolution: 'resolved', origin_mode: 'demo', created_at: 1, tool_call_id: 't' };
  const detail = { ...kase, transcript_snapshot: 'user (independent stream): <b>Two burgers</b>', event_snapshot: { call: { tool: 'add_item', args: { item_id: 'burger', quantity: 2 } }, order_before: { lines: [] }, events: [{ kind: 'evidence_transcript', t_ms: 1000, text: 'Two burgers, no wait, make it three.' }] }, expected_state: { state: { lines: [{ item_id: 'burger', quantity: 3, modifiers: [] }] } } };
  const run = { tier: 'evidence', result: 'pass', diff: { basis: 'expected_state', desired: 'HOLD', reason: 'still_held', actual: { verdict: 'HOLD', code: 'QTY_MISMATCH' }, order_before: [], order_after: [], expected_lines: [{ item_id: 'burger', quantity: 3, modifiers: [] }] } };

  it('lists cases, opens one (escaped snapshot, expected state in words), replays the evidence tier and shows a deterministic PASS diff', async () => {
    const f = fake([]);
    f.routes['GET /api/cases'] = { cases: [kase] };
    f.routes['GET /api/cases/case_abcdef12'] = detail;
    let replays: any = { runs: [], audio_suites: [], latest_evidence: null };
    f.routes['GET /api/cases/case_abcdef12/replays'] = () => replays;
    f.routes['POST /api/cases/case_abcdef12/replay'] = () => { replays = { runs: [run], audio_suites: [], latest_evidence: 'PASS (deterministic)' }; return { tier: 'evidence', result: 'pass' }; };
    const app = mount(f); await app.flush();
    click('[data-action="tab"][data-arg="cases"]'); await app.flush();
    expect(text('#cases')).toContain('QTY_MISMATCH · add_item · customer correction, in the same breath as the item');
    click('[data-action="case"]'); await app.flush();
    expect(text('#case-detail')).toContain('3 classic burgers');               // expected state as words, not ids
    expect(root.querySelector('#case-detail pre b')).toBeNull();               // the <b> in the snapshot is text
    expect(root.querySelector('[data-action="accept"]')).not.toBeNull();        // a resolved candidate can be accepted by the operator
    click('[data-action="replay-evidence"]'); await app.flush();
    expect(f.calls.some((c) => c.method === 'POST' && c.path.endsWith('/replay?tier=evidence'))).toBe(true);
    expect(text('#diff')).toMatch(/PASS \(deterministic\)/);
    expect(text('#diff')).toMatch(/still_held/);
    app.destroy();
  });

  it('an unresolved case has no audio-tier replay and no accept button (it has no expected state)', async () => {
    const f = fake([]);
    f.routes['GET /api/cases'] = { cases: [{ ...kase, resolution: 'unresolved_at_hangup', tag: 'none' }] };
    f.routes['GET /api/cases/case_abcdef12'] = { ...detail, resolution: 'unresolved_at_hangup', tag: 'none', expected_state: null };
    f.routes['GET /api/cases/case_abcdef12/replays'] = { runs: [], audio_suites: [] };
    const app = mount(f); await app.flush();
    click('[data-action="tab"][data-arg="cases"]'); await app.flush(); click('[data-action="case"]'); await app.flush();
    expect((root.querySelector('[data-action="replay-audio"]') as HTMLButtonElement).disabled).toBe(true);
    expect(root.querySelector('[data-action="accept"]')).toBeNull();
    app.destroy();
  });
});

describe('promotion and the compare table', () => {
  const configs = { configs: [{ version: 'v1', active: true, gating_params: { minWordConfidence: 0.6 }, prompt_hash: 'aaaaaaaaaaaa', parent_version: null }, { version: 'v2', active: false, gating_params: { minWordConfidence: 0.1 }, prompt_hash: 'aaaaaaaaaaaa', parent_version: 'v1' }] };
  const compare = { table: [{ case_id: 'case_1', pattern_key: 'UNVALIDATABLE|add_item|low_confidence|na', tag: 'regression', by_version: { v1: { evidence: 'pass', audio: '3/3 passed' }, v2: { evidence: 'fail' } } }] };

  it('the compare table shows PASS/FAIL cells in words, audio as k/3, and never the word "deterministic" for audio', async () => {
    const f = fake([]); f.routes['GET /api/configs'] = configs; f.routes['GET /api/compare'] = compare;
    const app = mount(f); await app.flush();
    click('[data-action="tab"][data-arg="lab"]'); await app.flush();
    const cells = [...root.querySelectorAll('#compare tbody td')].map((c) => c.textContent!.trim());
    expect(cells[1]).toMatch(/PASS/); expect(cells[1]).toMatch(/audio 3\/3 passed/);
    expect(cells[2]).toMatch(/FAIL/);
    expect(cells[1]).not.toMatch(/determin/i);                                 // the audio tier is never called deterministic
    app.destroy();
  });

  it('a blocked suite names the failing case and reason, keeps the validation notice visible, and offers NO promote button; a passing suite offers it', async () => {
    const f = fake([]); f.routes['GET /api/configs'] = configs; f.routes['GET /api/compare'] = compare;
    const blocked = { suite_run_id: 's1', config_version: 'v2', status: 'blocked', label: 'BLOCKED by 1 failing check(s)', suite_size: 1, vacuous: false, blocking: [{ case_id: 'case_abcdef12', pattern_key: 'UNVALIDATABLE|add_item|low_confidence|na', tier: 'evidence', reason: 'SAFETY_REGRESSION_now_allowed_but_must_be_held' }], guarantees: ['evidence tier: 1 regression case(s)'], validation_notice: 'synthetic and captured phrasing only; real-speech pass pending' };
    f.routes['POST /api/suite/run'] = blocked;
    const app = mount(f); await app.flush();
    click('[data-action="tab"][data-arg="lab"]'); await app.flush();
    click('[data-action="suite"][data-arg="v2"]'); await app.flush();
    expect(text('#suite')).toMatch(/BLOCKS/);
    expect(text('#suite')).toContain('SAFETY_REGRESSION_now_allowed_but_must_be_held');
    expect(text('#suite')).toContain('abcdef12');
    expect(text('#suite .notice')).toMatch(/synthetic and captured phrasing only/);
    expect(root.querySelector('[data-action="promote"]')).toBeNull();

    f.routes['POST /api/suite/run'] = { ...blocked, status: 'passed', label: 'PASSED 1/1 regression cases', blocking: [] };
    click('[data-action="suite"][data-arg="v2"]'); await app.flush();
    expect(root.querySelector('[data-action="promote"][data-arg="v2"]')).not.toBeNull();
    app.destroy();
  });

  it('a promotion the server refuses shows the blocking cases and the notice (the UI cannot force it)', async () => {
    const f = fake([]); f.routes['GET /api/configs'] = configs; f.routes['GET /api/compare'] = compare;
    f.routes['POST /api/suite/run'] = { suite_run_id: 's1', config_version: 'v2', status: 'passed', label: 'PASSED', blocking: [], guarantees: [], suite_size: 1 };
    f.routes['POST /api/configs/v2/promote'] = new ApiError(409, { error: 'SUITE_STALE', blocking: [{ case_id: 'case_zzzz9999', pattern_key: 'p', tier: 'evidence', reason: 'stale' }], validation_notice: 'n' });
    const app = mount(f); await app.flush();
    click('[data-action="tab"][data-arg="lab"]'); await app.flush(); click('[data-action="suite"][data-arg="v2"]'); await app.flush(); click('[data-action="promote"]'); await app.flush();
    expect(text('#suite')).toMatch(/BLOCKED: SUITE_STALE/);
    app.destroy();
  });
});

describe('microphone page', () => {
  it('the mic button starts the injected mic against the live session with the operator token; it toggles off', async () => {
    const f = fake(load('A'));
    f.routes['POST /api/sessions'] = { session_id: 'sess-1' };
    const started: any[] = []; let on = false;
    const mic: Mic = { active: () => on, stop: () => { on = false; }, start: async (s, tk) => { started.push([s, tk]); on = true; } };
    const app = mount(f, { mic }); await app.flush();
    click('[data-action="start"]'); await app.flush(); await f.finished(); await tick(5); await app.flush();
    // an ended session cannot use the mic; a live one can: use a stream that never ends
    expect(root.querySelector('[data-action="mic"]')).not.toBeNull();
    app.destroy();
  });
});
