// The operator dashboard: mounts into a root element with injected dependencies (api, mic, clock) so the same code runs in the browser and
// under test. State changes only through `reduce` (live events) or an explicit action; rendering is string views + one delegated listener.
import { createApi, type Api } from './api.js';
import { esc } from './escape.js';
import { createMic, type Mic } from './mic.js';
import { initialLive, reduce, reduceAll, type Ev, type LiveState } from './state.js';
import { casesView, header, labView, liveView, metricsView } from './views.js';

export interface Deps {
  api: Api;
  mic?: Mic;
  now?: () => number;
  /** the raw operator token, held only for the mic WS's first-frame auth (D-39: the SAME credential as `/api/login`, no second secret) */
  token: { get(): string; set(t: string): void; clear(): void };
  /** background refresh period in ms (0 disables; tests drive refresh explicitly) */
  pollMs?: number;
}
export interface UiState {
  /** D-39: guest (no login) is the default and needs nothing; operator comes from a session-cookie login and unlocks mutating actions */
  role: 'guest' | 'operator'; tab: 'live' | 'cases' | 'lab' | 'metrics'; live: LiveState; counts: any | null; metrics: any | null;
  scenarios: { name: string; label: string }[]; demoBanner: string | null; busy: string | null; sessions: any[]; mic: boolean;
  cases: any[]; caseDetail: any | null; replays: any | null; compare: any[]; configs: any[]; suite: any | null; adversarial: any | null; error: string | null;
}

export const FALLBACK_NOTICE = 'Validation status: the regression suite is synthetic and captured phrasing only; the real-speech pass and live-agent validation are pending. A pass means no KNOWN failure regressed.';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function mountApp(root: HTMLElement, deps: Deps): { destroy(): void; state(): UiState; flush(): Promise<void>; refresh(): Promise<void>; attach(id: string): Promise<void> } {
  const { api } = deps;
  const now = deps.now ?? (() => Date.now());
  const mic = deps.mic;
  const ui: UiState = {
    role: 'guest', tab: 'live', live: initialLive(), counts: null, metrics: null, scenarios: [], demoBanner: null, busy: null, sessions: [], mic: false,
    cases: [], caseDetail: null, replays: null, compare: [], configs: [], suite: null, adversarial: null, error: null,
  };
  let stream: AbortController | null = null; let timer: ReturnType<typeof setInterval> | null = null; let tick: ReturnType<typeof setInterval> | null = null;
  let scheduled = false; let dead = false; let pending: Promise<unknown>[] = [];

  const track = <T,>(p: Promise<T>): Promise<T> => { pending.push(p); void p.finally(() => { pending = pending.filter((x) => x !== p); }).catch(() => undefined); return p; };
  // a 401 is an invalid/expired credential (demote to guest); a 403 is a guest correctly refused a mutating route (nothing to demote)
  const fail = (e: unknown) => { ui.error = e instanceof Error ? e.message : String(e); if (e && (e as { status?: number }).status === 401) { ui.role = 'guest'; deps.token.clear(); } render(); };

  // ---------- rendering (string views; everything escaped inside the views; guest never sees the Lab tab or a mutating button)
  function body(): string {
    if (ui.tab === 'cases') return casesView(ui.cases, ui.caseDetail, ui.replays, ui.busy, ui.role);
    if (ui.tab === 'lab') return labView({ compare: ui.compare, configs: ui.configs, suite: ui.suite, notice: ui.suite?.validation_notice ?? FALLBACK_NOTICE, busy: ui.busy, adversarial: ui.adversarial });
    if (ui.tab === 'metrics') return metricsView(ui.metrics);
    return liveView(ui.live, { now: now(), scenarios: ui.scenarios, mic: ui.mic, busy: ui.busy, sessions: ui.sessions, role: ui.role });
  }
  function render(): void {
    if (dead) return;
    root.innerHTML = `<div id="hdr">${header({ tab: ui.tab, counts: ui.counts, metrics: ui.metrics, demoBanner: ui.demoBanner, role: ui.role })}</div>${ui.error ? `<div class="err" role="alert">${esc(ui.error)} <button data-action="dismiss">dismiss</button></div>` : ''}<main id="main">${body()}</main>`;
  }
  function schedule(): void { if (scheduled) return; scheduled = true; queueMicrotask(() => { scheduled = false; render(); }); }

  // ---------- data
  async function refresh(): Promise<void> {
    try {
      const [counts, metrics, sessions] = await Promise.all([api.get('/api/regressions/count'), api.get('/api/metrics'), api.get('/api/sessions')]);
      ui.counts = counts; ui.metrics = metrics; ui.sessions = sessions.sessions ?? [];
      if (ui.tab === 'cases') ui.cases = (await api.get('/api/cases')).cases;
      if (ui.tab === 'lab' && ui.role === 'operator') await loadLab();
      render();
    } catch (e) { fail(e); }
  }
  async function loadLab(): Promise<void> {
    const [cfg, cmp] = await Promise.all([api.get('/api/configs'), api.get('/api/compare')]);
    ui.configs = cfg.configs; ui.compare = cmp.table;
  }
  /** guest-visible from the moment the page loads: no login required. A pre-existing session cookie (page reload) is picked up here too. */
  async function bootstrap(): Promise<void> {
    try {
      const who = await api.get('/api/whoami');
      ui.role = who.role === 'operator' ? 'operator' : 'guest';
    } catch { ui.role = 'guest'; }
    try {
      const sc = await api.get('/api/demo/scenarios');
      ui.scenarios = sc.scenarios; ui.demoBanner = sc.banner;
      await refresh();
      if (deps.pollMs) timer = setInterval(() => { void refresh(); }, deps.pollMs);
    } catch (e) { ui.error = e instanceof Error ? e.message : String(e); render(); }
  }

  async function attach(id: string): Promise<void> {
    stream?.abort();
    const ctl = new AbortController(); stream = ctl;
    ui.live = initialLive(); ui.tab = 'live';
    const active = (await api.get('/api/sessions')).active as string[];
    if (!active.includes(id)) {                                             // a finished session: replay its stored events through the same reducer
      const r = await api.get(`/api/sessions/${encodeURIComponent(id)}/events`);
      ui.live = reduceAll(r.events as Ev[]);
      render(); return;
    }
    render();
    // NOT tracked: a live stream stays open for the whole call, and `flush` must only wait for finite work
    void (api.stream(`/api/live/${encodeURIComponent(id)}`, (e: Ev) => {
      ui.live = reduce(ui.live, e);
      if (e.kind === 'case' || e.kind === 'verdict') void track(refreshCounts());
      if (ui.tab === 'live') schedule();
    }, ctl.signal).catch(() => undefined));
    await sleep(0);
    startTick();
  }
  async function refreshCounts(): Promise<void> { try { [ui.counts, ui.metrics] = await Promise.all([api.get('/api/regressions/count'), api.get('/api/metrics')]); const h = root.querySelector('#hdr'); if (h) h.innerHTML = header({ tab: ui.tab, counts: ui.counts, metrics: ui.metrics, demoBanner: ui.demoBanner, role: ui.role }); } catch { /* the next refresh will retry */ } }
  function startTick(): void { if (tick || !deps.pollMs) return; tick = setInterval(() => { if (ui.live.waiting && ui.tab === 'live') schedule(); }, 250); }

  async function busy<T>(msg: string, f: () => Promise<T>): Promise<T | undefined> {
    ui.busy = msg; render();
    try { return await f(); } catch (e) { fail(e); return undefined; } finally { ui.busy = null; render(); }
  }

  // ---------- actions (each is one operator gesture)
  const actions: Record<string, (arg: string) => Promise<void>> = {
    dismiss: async () => { ui.error = null; render(); },
    tab: async (t) => { ui.tab = t as UiState['tab']; render(); await refresh(); },
    start: async () => { await busy('starting call…', async () => { const r = await api.post('/api/sessions', { mode: 'live' }); await attach(r.session_id); }); },
    end: async () => { const id = ui.live.session_id; if (!id) return; if (ui.mic) { mic?.stop(); ui.mic = false; } await busy('ending…', async () => { await api.post(`/api/sessions/${encodeURIComponent(id)}/end`); }); await refresh(); },
    mic: async () => {
      const id = ui.live.session_id; if (!id || !mic) return;
      if (ui.mic) { mic.stop(); ui.mic = false; render(); return; }
      try { await mic.start(id, deps.token.get(), (s) => { ui.busy = s === 'mic on' ? null : s; render(); }); ui.mic = true; } catch (e) { ui.mic = false; fail(e); }
      render();
    },
    demo: async (name) => {
      await busy(`running scenario ${name}…`, async () => {
        const r = await api.post(`/api/demo/${encodeURIComponent(name)}`);
        let shown = 0;
        for (;;) {
          const run = await api.get(`/api/demo/runs/${encodeURIComponent(r.run_id)}`);
          if (run.sessions.length > shown) { shown = run.sessions.length; await attach(run.sessions[shown - 1]); ui.busy = `running scenario ${name}…`; }
          if (run.status !== 'running') { if (run.status === 'error') throw new Error(run.error); break; }
          await sleep(deps.pollMs === 0 ? 20 : 400);
        }
      });
      await refresh();
    },
    attach: async (id) => { await attach(id); },
    case: async (id) => {
      ui.caseDetail = await api.get(`/api/cases/${encodeURIComponent(id)}`); ui.replays = await api.get(`/api/cases/${encodeURIComponent(id)}/replays`); render();
    },
    audio: async (id) => {
      const blob = await api.blob(`/api/cases/${encodeURIComponent(id)}/audio`);
      const slot = root.querySelector('#audio-slot'); if (!slot) return;
      const a = document.createElement('audio'); a.controls = true; a.src = URL.createObjectURL(blob); slot.replaceChildren(a);
    },
    'replay-evidence': async (id) => {
      await busy('replaying (evidence tier)…', async () => { await api.post(`/api/cases/${encodeURIComponent(id)}/replay?tier=evidence`); ui.replays = await api.get(`/api/cases/${encodeURIComponent(id)}/replays`); });
    },
    'replay-audio': async (id) => {
      await busy('replaying (audio tier, k=3, real time)…', async () => {
        const r = await api.post(`/api/cases/${encodeURIComponent(id)}/replay?tier=audio`);
        for (;;) { const j = await api.get(`/api/replays/${encodeURIComponent(r.suite_run_id)}`); if (j.status !== 'running') break; await sleep(deps.pollMs === 0 ? 20 : 1000); }
        ui.replays = await api.get(`/api/cases/${encodeURIComponent(id)}/replays`);
      });
    },
    accept: async (id) => { await api.post(`/api/cases/${encodeURIComponent(id)}/accept`); await actions.case!(id); await refresh(); },
    suite: async (version) => { await busy('running all regression cases…', async () => { ui.suite = await api.post('/api/suite/run', { config_version: version }); await loadLab(); }); },
    promote: async (version) => {
      const sid = ui.suite?.suite_run_id;
      await busy('promoting…', async () => {
        try { await api.post(`/api/configs/${encodeURIComponent(version)}/promote`, { suite_run_id: sid }); ui.suite = null; }
        catch (e) { const b = (e as { body?: any }).body; if (b?.blocking) ui.suite = { ...(ui.suite ?? {}), status: 'blocked', blocking: b.blocking, label: `BLOCKED: ${b.error}`, validation_notice: b.validation_notice }; else throw e; }
        await loadLab();
      });
    },
    rollback: async () => { await busy('rolling back…', async () => { await api.post('/api/configs/rollback'); await loadLab(); }); },
    adversarial: async () => { await busy('running the adversarial harness…', async () => { ui.adversarial = await api.get('/api/adversarial'); }); },
    logout: async () => {
      await busy('signing out…', async () => { await api.post('/api/logout'); });
      deps.token.clear(); ui.role = 'guest'; if (ui.tab === 'lab') ui.tab = 'live';
      await refresh();
    },
  };

  const onClick = (ev: Event) => {
    const el = (ev.target as HTMLElement | null)?.closest?.('[data-action]') as HTMLElement | null;
    if (!el || (el as HTMLButtonElement).disabled) return;
    const fn = actions[el.dataset.action ?? ''];
    if (fn) void track(fn(el.dataset.arg ?? '').catch(fail));
  };
  const onSubmit = (ev: Event) => {
    const form = ev.target as HTMLFormElement; const kind = form?.dataset?.form; if (!kind) return;
    ev.preventDefault();
    const fd = new FormData(form);
    if (kind === 'login') {
      const tok = String(fd.get('token') ?? '');
      void track(busy('signing in…', async () => {
        await api.post('/api/login', { token: tok });          // sets the session cookie; the SAME credential, no second secret
        deps.token.set(tok);                                    // kept only for the mic WS's first-frame auth
        ui.role = 'operator'; ui.error = null;
        await refresh();
      }));
      return;
    }
    if (kind === 'config') {
      void track(busy('creating version…', async () => {
        const params: Record<string, number> = {};
        for (const k of ['minWordConfidence', 'evidenceWaitMaxMs']) { const v = String(fd.get(k) ?? '').trim(); if (v) params[k] = Number(v); }
        const active = ui.configs.find((c) => c.active);
        const src = active ? await api.get(`/api/configs/${encodeURIComponent(active.version)}`) : null;
        await api.post('/api/configs', { version: String(fd.get('version') ?? ''), prompt_text: src?.prompt_text ?? '', gating_params: { ...(active?.gating_params ?? {}), ...params } });
        await loadLab();
      }));
    }
  };
  root.addEventListener('click', onClick);
  root.addEventListener('submit', onSubmit);

  render(); // the guest shell renders immediately; bootstrap() fills it in (and may upgrade role to operator from an existing session cookie)
  void track(bootstrap());
  return {
    destroy: () => { dead = true; stream?.abort(); if (timer) clearInterval(timer); if (tick) clearInterval(tick); root.removeEventListener('click', onClick); root.removeEventListener('submit', onSubmit); },
    state: () => ui,
    flush: async () => { for (let i = 0; i < 40 && pending.length; i++) await Promise.allSettled([...pending]); await sleep(0); render(); },
    refresh, attach,
  };
}

// ---------- browser entry
if (typeof window !== 'undefined' && typeof document !== 'undefined' && (window as { __TALLY_TEST__?: boolean }).__TALLY_TEST__ !== true) {
  const KEY = 'tally.operator';
  const store = { get: () => { try { return sessionStorage.getItem(KEY) ?? ''; } catch { return ''; } }, set: (t: string) => { try { sessionStorage.setItem(KEY, t); } catch { /* private mode */ } }, clear: () => { try { sessionStorage.removeItem(KEY); } catch { /* private mode */ } } };
  const root = document.getElementById('app');
  if (root) mountApp(root, { api: createApi(() => store.get()), mic: createMic(), token: store, pollMs: 5000 });
}
