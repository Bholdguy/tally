// HTML views as PURE functions of data (strings out). Everything that is not a literal in this file goes through `esc`. Item and option
// names are shown as words (contract helpers), never raw ids; codes are shown as operator-facing labels next to a plain-language line.
import { CONFLICT_CODES, MENU, describeLine, itemName } from '@tally/contract';
import { esc, idAttr } from './escape.js';
import { CLASS_OF, layout, renderSvg } from './timeline.js';
import { describePattern, statusLabel, toolName, type LiveState, type OrderView } from './state.js';

const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const pct = (v: number | null | undefined) => (v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(0)}%`);
const ms = (v: number | null | undefined) => (v === null || v === undefined ? '–' : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`);
const known = new Set<string>(CONFLICT_CODES);

export const CODE_HELP: Record<string, string> = {
  QTY_MISMATCH: 'the quantity the agent used differs from what the customer said', ITEM_MISMATCH: 'a different item than the customer asked for',
  MODIFIER_MISMATCH: 'options differ from what the customer asked for', REMOVAL_MISMATCH: 'a removal differs from what the customer asked for',
  SUBSTITUTION_MISMATCH: 'a substitution differs from what the customer asked for', UNSUPPORTED_CLAIM: 'nothing the customer said supports this',
  UNVALIDATABLE: 'Tally could not verify this (evidence missing, unclear or unavailable)', PENDING_EVIDENCE: 'the customer was still speaking when time ran out',
  SPOKEN_STATE_DRIFT: 'the agent said something the order does not say', TOTAL_MISMATCH: 'the agent said a total the order does not have', PICKUP_TIME_MISMATCH: 'the pickup time differs',
  SCHEMA_INVALID: 'the call was malformed', UNKNOWN_ITEM: 'not a menu item', BAD_MODIFIER: 'not an option for that item', TOOL_RESULT_LIE: 'the tool result did not match what was stored',
  STALE_EVIDENCE: 'the evidence is older than the customer\'s correction',
};
export const codeChip = (code?: string) => (code ? `<span class="code" title="${esc(CODE_HELP[code] ?? (known.has(code) ? '' : 'unrecognised code'))}">${esc(code)}</span>` : '');
export const badge = (status: keyof typeof CLASS_OF, text: string) => `<span class="badge ${CLASS_OF[status]}"><span class="dot" aria-hidden="true"></span>${esc(text)}</span>`;

export function orderPanel(o: OrderView | null): string {
  if (!o) return '<div class="panel" id="order"><h3>Order</h3><p class="muted">No order yet.</p></div>';
  const rows = o.lines.length ? o.lines.map((l) => `<li>${esc(describeLine(l))}</li>`).join('') : '<li class="muted">nothing yet</li>';
  return `<div class="panel" id="order"><h3>Order <span class="muted">(committed)</span></h3><ul>${rows}</ul><div class="total">Total <strong>${esc(money(o.total_cents))}</strong> · ${esc(o.status)}</div></div>`;
}

export function callLog(s: LiveState): string {
  const rows = s.log.map((l) => `<li class="log ${esc(l.kind)} ${l.status ? esc(CLASS_OF[l.status]) : ''}"><span class="t">${(l.t / 1000).toFixed(1)}s</span> ${esc(l.text)}</li>`).join('');
  return `<div class="panel" id="calllog"><h3>Call log</h3><ol>${rows || '<li class="muted">no events yet</li>'}</ol></div>`;
}

export function transcripts(s: LiveState): string {
  const col = (title: string, note: string, lines: { text: string; final: boolean; low?: boolean }[]) =>
    `<div class="col"><h4>${esc(title)}</h4><p class="muted">${esc(note)}</p>${lines.map((l) => `<p class="line ${l.final ? 'final' : 'partial'} ${l.low ? 'low' : ''}">${esc(l.text)}${l.low ? ' <span class="badge wait">low confidence</span>' : ''}</p>`).join('') || '<p class="muted">(nothing)</p>'}</div>`;
  return `<div class="panel two" id="transcripts">${col('Independent stream', "Tally's own transcription of the customer: the evidence", s.transcripts.independent)}${col('Voice Agent stream', "what the agent's own recognizer heard (not trusted)", s.transcripts.voiceAgent)}${col('Agent said', 'spoken by the agent', s.transcripts.agent)}</div>`;
}

/** beat 5b: a first-class state, not an implementation detail. `now` is passed in so the view stays pure. */
export function waitingChip(s: LiveState, now: number): string {
  const w = s.waiting;
  // the outage chip shows while a call is live and the stream is down, and stays if a call was HELD BECAUSE of the outage (the point of beat 8b);
  // a stream that merely closes because the call ended is not an outage
  const heldByOutage = s.calls.some((c) => c.status === 'held' && /evidence stream is (down|unknown)/.test(c.detail ?? ''));
  if (!w) return s.stream.status === 'down' && (!s.ended || heldByOutage) ? `<div class="chip bad" id="wait-chip">⛔ EVIDENCE STREAM DOWN → calls are HELD (fail closed)${s.stream.reason ? ` · ${esc(s.stream.reason)}` : ''}</div>` : '';
  const elapsed = Math.max(0, now - w.since_wall);
  return `<div class="chip wait" id="wait-chip" role="status">⏳ WAITING ON INDEPENDENT EVIDENCE · ${esc(w.reason || 'customer still speaking')} · ${(elapsed / 1000).toFixed(1)} s / ${(w.max_ms / 1000).toFixed(1)} s <span class="muted">— the agent asked for ${esc(toolName(w.tool))}; Tally will not trust it until the customer's words are in.</span></div>`;
}

export function metricsStrip(m: any | null): string {
  if (!m) return '<div class="strip" id="metrics"><span class="muted">metrics loading…</span></div>';
  const st = m.stages;
  const chip = (label: string, x: any) => `<span class="mchip" title="computed from ${esc(x.n)} stored sample(s); client-observed"><b>${esc(label)}</b> p50 ${esc(ms(x.p50))} · p95 ${esc(ms(x.p95))} <i>n=${esc(x.n)}</i></span>`;
  const r = m.rates;
  return `<div class="strip" id="metrics">${chip('STT', st.stt)}${chip('Gate', st.gate)}${chip('Repair', st.repair)}${chip('Commit', st.commit)}${chip('First audio', st.first_audio)}${chip('Barge-in', st.barge_in)}
<span class="mchip"><b>Conflict rate</b> ${esc(pct(r.conflict_rate.value))} <i>${esc(r.conflict_rate.n)}/${esc(r.conflict_rate.of)}</i></span>
<span class="mchip"><b>Repair success</b> ${esc(pct(r.repair_success_rate.value))} <i>${esc(r.repair_success_rate.n)}/${esc(r.repair_success_rate.of)}</i></span>
<span class="mchip" title="${esc(r.false_positive_rate.note)}"><b>False-positive holds</b> ${esc(pct(r.false_positive_rate.value))} <i>${esc(r.false_positive_rate.n)}/${esc(r.false_positive_rate.of)}</i></span>
<span class="mchip"><b>Regression pass</b> ${esc(pct(r.regression_pass_rate.value))} <i>${esc(r.regression_pass_rate.n)}/${esc(r.regression_pass_rate.of)}</i></span>
<span class="mchip" title="${esc(r.final_order_accuracy.note)}"><b>Final order accuracy</b> ${esc(r.final_order_accuracy.n)}/${esc(r.final_order_accuracy.of)}</span>
<span class="muted small">latency is client-observed; every number is computed from stored rows</span></div>`;
}

/** the persistent guest/operator label (D-39): always on screen, never only a hidden/shown button, so a judge always knows which tier they're in */
export function tierBanner(role: 'guest' | 'operator'): string {
  return role === 'operator'
    ? `<div class="tier-banner operator" id="tier-banner"><span class="badge ok"><span class="dot"></span>Operator view (logged in)</span><span class="muted small">replay, accept, promote, rollback and config changes are unlocked</span><button data-action="logout" class="link">Log out</button></div>`
    : `<div class="tier-banner guest" id="tier-banner"><span class="badge wait"><span class="dot"></span>Guest view</span><span class="muted small">read-only, plus demo playback — sign in to replay, accept regressions, promote or roll back</span><form data-form="login" class="controls inline"><input name="token" type="password" autocomplete="off" placeholder="operator token" required/><button type="submit">Operator sign-in</button></form></div>`;
}

export function header(ui: { tab: string; counts: any | null; metrics: any | null; demoBanner: string | null; role: 'guest' | 'operator' }): string {
  const c = ui.counts;
  const m = ui.metrics?.rates?.final_order_accuracy;
  const tabNames = ui.role === 'operator' ? ['live', 'cases', 'lab', 'metrics'] : ['live', 'cases', 'metrics'];
  const tabs = tabNames.map((t) => `<button class="tab ${ui.tab === t ? 'on' : ''}" data-action="tab" data-arg="${t}" aria-pressed="${ui.tab === t}">${esc(t[0]!.toUpperCase() + t.slice(1))}</button>`).join('');
  return `<header><h1>Tally <span class="muted">reliability layer</span></h1><nav>${tabs}</nav>
<div class="counters"><span class="cnt" id="cnt-cases">Cases <b>${esc(c?.cases ?? 0)}</b></span><span class="cnt" id="cnt-cand">Candidates <b>${esc(c?.candidates ?? 0)}</b></span><span class="cnt" id="cnt-reg">Regressions <b>${esc(c?.regressions ?? 0)}</b></span><span class="cnt" id="cnt-acc">Accuracy <b>${m ? `${esc(m.n)}/${esc(m.of)}` : 'n/a'}</b></span></div>
${ui.demoBanner ? `<div class="banner">${esc(ui.demoBanner)}</div>` : ''}</header>${tierBanner(ui.role)}`;
}

export function liveView(s: LiveState, ui: { now: number; scenarios: { name: string; label: string }[]; mic: boolean; busy: string | null; sessions: any[]; role: 'guest' | 'operator' }): string {
  const live = !!s.session_id && !s.ended;
  const scen = ui.scenarios.map((x) => `<button data-action="demo" data-arg="${idAttr(x.name)}" ${ui.busy ? 'disabled' : ''}>${esc(x.label)}</button>`).join('');
  const past = ui.sessions.slice(0, 8).map((x) => `<button class="link" data-action="attach" data-arg="${idAttr(x.id)}">${esc(x.mode)} · ${esc(new Date(x.started_at).toLocaleTimeString())}${x.ended_at ? '' : ' · live'}</button>`).join(' ');
  const opControls = ui.role === 'operator'
    ? `<div class="controls"><button data-action="start" ${live || ui.busy ? 'disabled' : ''}>Start live call</button><button data-action="end" ${live ? '' : 'disabled'}>End call</button>
<button data-action="mic" ${live ? '' : 'disabled'} aria-pressed="${ui.mic}">${ui.mic ? '🎙 Mic on: stop' : '🎙 Use microphone'}</button>${ui.busy ? `<span class="muted">${esc(ui.busy)}</span>` : ''}</div>`
    : `<p class="muted small">Guest view: starting a real call and the microphone need operator sign-in. The scenarios below run the same real pipeline against prerecorded audio.</p>`;
  return `<section id="live">
${opControls}
<div class="controls"><span class="muted">Deterministic demo (scripted agent, prerecorded audio):</span>${scen}</div>
${past ? `<div class="controls"><span class="muted">Sessions:</span>${past}</div>` : ''}
${waitingChip(s, ui.now)}
<div class="panel" id="timeline"><h3>Evidence timeline <span class="muted">${s.session_id ? esc(s.session_id.slice(0, 18)) : 'no session'}${s.mode ? ` · ${esc(s.mode)}` : ''}</span></h3>${renderSvg(layout(s))}
<p class="legend"><span class="badge ok"><span class="dot"></span>ALLOWED</span> <span class="badge repaired"><span class="dot"></span>REPAIRED</span> <span class="badge bad"><span class="dot"></span>CONFLICT / HELD</span> <span class="badge wait"><span class="dot"></span>WAITING</span> ◆ barge-in (derived) · ┃ independent stream heard speech</p></div>
${transcripts(s)}<div class="two-col">${callLog(s)}${orderPanel(s.order)}</div></section>`;
}

const callRows = (s: LiveState) => s.calls.map((c) => `<tr><td>${esc(toolName(c.tool))}</td><td>${badge(c.status, statusLabel(c))}</td><td>${esc(typeof c.waited_ms === 'number' ? ms(c.waited_ms) : '')}</td></tr>`).join('');
export const callTable = (s: LiveState) => `<table class="t"><thead><tr><th>Call</th><th>Verdict</th><th>Waited</th></tr></thead><tbody>${callRows(s)}</tbody></table>`;

export function casesView(list: any[], detail: any | null, replays: any | null, busy: string | null, role: 'guest' | 'operator'): string {
  const rows = list.map((c) => `<tr class="${detail?.id === c.id ? 'sel' : ''}"><td><button class="link" data-action="case" data-arg="${idAttr(c.id)}">${esc(String(c.id).slice(-8))}</button></td><td>${codeChip(c.conflict_type)}</td><td class="mono" title="${esc(c.pattern_key)}">${esc(describePattern(c.pattern_key))}</td><td><span class="badge ${c.tag === 'regression' ? 'ok' : c.tag === 'regression_candidate' ? 'wait' : 'muted'}">${esc(c.tag)}</span></td><td>${esc(c.resolution)}</td><td>${esc(c.origin_mode)}</td></tr>`).join('');
  return `<section id="cases"><div class="panel"><h3>Cases <span class="muted">(every hold is a stored, replayable case)</span></h3><table class="t"><thead><tr><th>Case</th><th>Conflict</th><th>Pattern</th><th>Tag</th><th>Resolution</th><th>Origin</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="muted">no cases yet</td></tr>'}</tbody></table></div>${detail ? caseDetail(detail, replays, busy, role) : ''}</section>`;
}

function caseDetail(c: any, replays: any | null, busy: string | null, role: 'guest' | 'operator'): string {
  const snap = c.event_snapshot ?? {};
  const before = (snap.order_before?.lines ?? []).map((l: any) => esc(describeLine(l))).join(', ') || 'empty';
  const exp = c.expected_state ? c.expected_state.state.lines.map((l: any) => esc(describeLine(l))).join(', ') || 'empty' : null;
  const evs = (snap.events ?? []).filter((e: any) => ['evidence_transcript', 'tool_call'].includes(e.kind)).map((e: any) => `<li class="mono">${((e.t_ms ?? 0) / 1000).toFixed(1)}s ${esc(e.kind)} ${esc(e.kind === 'evidence_transcript' ? `"${e.text}"` : `${e.tool} ${JSON.stringify(e.args ?? {})}`)}</li>`).join('');
  const call = snap.call ? `${esc(toolName(snap.call.tool))} ${esc(JSON.stringify(snap.call.args ?? {}))}` : '';
  const suites = (replays?.audio_suites ?? []).map((a: any) => `<li>audio tier: <b>${esc(a.label)}</b> <span class="muted">(${esc(a.k)} live runs; never "deterministic")</span></li>`).join('');
  const last = replays?.runs?.filter((r: any) => r.tier === 'evidence').slice(-1)[0];
  const opControls = role === 'operator'
    ? `<div class="controls"><button data-action="replay-evidence" data-arg="${idAttr(c.id)}" ${busy ? 'disabled' : ''}>Replay: evidence tier (deterministic)</button><button data-action="replay-audio" data-arg="${idAttr(c.id)}" ${busy || !c.expected_state ? 'disabled' : ''} title="${c.expected_state ? '' : 'needs a resolved case'}">Replay: audio tier (k=3, live agent)</button>${c.tag === 'regression_candidate' && c.resolution === 'resolved' ? `<button data-action="accept" data-arg="${idAttr(c.id)}">Accept as regression (operator)</button>` : ''}${busy ? `<span class="muted">${esc(busy)}</span>` : ''}</div>`
    : `<p class="muted small">Guest view: replaying this case or accepting it as a regression needs operator sign-in.</p>`;
  return `<div class="panel" id="case-detail"><h3>Case ${esc(String(c.id).slice(-8))} ${codeChip(c.conflict_type)}</h3>
<p><span class="badge ${c.resolution === 'resolved' ? 'ok' : 'wait'}">${esc(c.resolution)}</span> <span class="badge ${c.tag === 'regression' ? 'ok' : 'wait'}">${esc(c.tag)}</span> <span class="mono" title="${esc(c.pattern_key)}">${esc(describePattern(c.pattern_key))}</span></p>
<p>Recorded call: <span class="mono">${call}</span> — order before: ${before}${exp ? ` — expected after repair: <b>${exp}</b>` : ' — no expected state (not resolved)'}</p>
<div class="two"><div class="col"><h4>Customer audio</h4><button data-action="audio" data-arg="${idAttr(c.id)}">Load recording</button><div id="audio-slot"></div><h4>Transcript snapshot</h4><pre>${esc(c.transcript_snapshot)}</pre></div>
<div class="col"><h4>Stored evidence (independent stream and the call)</h4><ul>${evs}</ul></div></div>
${opControls}
${last ? diffViewer(last) : ''}<ul>${suites}</ul></div>`;
}

export function diffViewer(run: any): string {
  const d = run.diff ?? {};
  const pass = run.result === 'pass';
  return `<div class="diff" id="diff"><h4>Replay result: ${badge(pass ? 'allowed' : 'conflict', `${String(run.result).toUpperCase()}${run.tier === 'evidence' ? ' (deterministic)' : ''}`)}</h4>
<table class="t"><tbody><tr><th>Basis</th><td>${esc(d.basis)}</td></tr><tr><th>Should be</th><td>${esc(d.desired)}</td></tr><tr><th>Actually</th><td>${esc(d.actual?.verdict ?? (d.actual?.findings ? `${d.actual.findings.length} finding(s)` : ''))} ${codeChip(d.actual?.code)}</td></tr>
<tr><th>Why</th><td>${esc(d.reason)}</td></tr><tr><th>Order before</th><td>${esc((d.order_before ?? []).map((l: any) => describeLine(l)).join(', ') || 'empty')}</td></tr><tr><th>Order after replay</th><td>${esc((d.order_after ?? []).map((l: any) => describeLine(l)).join(', ') || 'empty')}</td></tr>
${d.expected_lines ? `<tr><th>Expected</th><td>${esc(d.expected_lines.map((l: any) => describeLine(l)).join(', ') || 'empty')}</td></tr>` : ''}</tbody></table></div>`;
}

export function compareTable(t: any[], versions: string[]): string {
  const head = versions.map((v) => `<th>${esc(v)}</th>`).join('');
  const cell = (r: any, v: string) => {
    const x = r.by_version?.[v];
    if (!x) return '<td class="muted">not run</td>';
    const ev = x.evidence ? badge(x.evidence === 'pass' ? 'allowed' : 'conflict', `${x.evidence.toUpperCase()}`) : '';
    return `<td>${ev}${x.audio ? ` <span class="small">audio ${esc(x.audio)}</span>` : ''}</td>`;
  };
  const rows = t.map((r) => `<tr><td class="mono" title="${esc(r.pattern_key)}">${esc(describePattern(r.pattern_key))} <span class="badge ${r.tag === 'regression' ? 'ok' : 'muted'}">${esc(r.tag)}</span></td>${versions.map((v) => cell(r, v)).join('')}</tr>`).join('');
  return `<div class="panel" id="compare"><h3>Compare: cases × config versions</h3><p class="muted small">evidence tier = deterministic PASS/FAIL; audio tier = k/3 (never deterministic)</p><table class="t"><thead><tr><th>Case (pattern)</th>${head}</tr></thead><tbody>${rows || `<tr><td colspan="${versions.length + 1}" class="muted">no cases yet</td></tr>`}</tbody></table></div>`;
}

export function suitePanel(rep: any | null, notice: string): string {
  const blocking = (rep?.blocking ?? []).map((b: any) => `<li>${badge('conflict', 'BLOCKS')} case <span class="mono">${esc(String(b.case_id ?? '(config)').slice(-8))}</span> ${esc(b.pattern_key ? describePattern(b.pattern_key) : '')} — ${esc(b.tier)}: <b>${esc(b.reason)}</b></li>`).join('');
  return `<div class="panel" id="suite"><h3>Promotion gate</h3>${rep ? `<p>${badge(rep.status === 'passed' ? 'allowed' : 'conflict', rep.label ?? rep.status)} for <b>${esc(rep.config_version)}</b> · ${esc(rep.suite_size)} regression case(s)${rep.vacuous ? ' · <b>vacuous: no regression cases yet</b>' : ''}</p><ul>${blocking}</ul><ul class="small">${(rep.guarantees ?? []).map((g: string) => `<li>${esc(g)}</li>`).join('')}</ul>` : '<p class="muted">Pick a version and run all cases.</p>'}<p class="notice" role="note">${esc(notice)}</p></div>`;
}

export function labView(ui: { compare: any[]; configs: any[]; suite: any | null; notice: string; busy: string | null; adversarial: any | null }): string {
  const versions = ui.configs.map((c) => c.version);
  const cfgRows = ui.configs.map((c) => `<tr><td>${esc(c.version)} ${c.active ? '<span class="badge ok"><span class="dot"></span>ACTIVE</span>' : ''}</td><td class="mono">${esc(JSON.stringify(c.gating_params))}</td><td class="mono">${esc(String(c.prompt_hash).slice(0, 10))}</td><td>${esc(c.parent_version ?? '–')}</td>
<td>${c.active ? '' : `<button data-action="suite" data-arg="${idAttr(c.version)}" ${ui.busy ? 'disabled' : ''}>Run all cases</button>`}${!c.active && ui.suite?.config_version === c.version && ui.suite.status === 'passed' ? `<button data-action="promote" data-arg="${idAttr(c.version)}">Promote</button>` : ''}</td></tr>`).join('');
  return `<section id="lab"><div class="panel"><h3>Configs</h3><table class="t"><thead><tr><th>Version</th><th>Gating parameters</th><th>Prompt hash</th><th>Parent</th><th></th></tr></thead><tbody>${cfgRows}</tbody></table>
<form data-form="config" class="controls"><input name="version" placeholder="new version, e.g. v3" required maxlength="40"/><input name="minWordConfidence" placeholder="minWordConfidence (0-1)" /><input name="evidenceWaitMaxMs" placeholder="evidenceWaitMaxMs" /><button type="submit">Create version</button></form>
<div class="controls"><button data-action="rollback">Roll back to parent</button>${ui.busy ? `<span class="muted">${esc(ui.busy)}</span>` : ''}</div></div>
${suitePanel(ui.suite, ui.notice)}${compareTable(ui.compare, versions)}${adversarialPanel(ui.adversarial)}</section>`;
}

export function adversarialPanel(a: any | null): string {
  if (!a) return `<div class="panel" id="adversarial"><h3>Adversarial harness</h3><button data-action="adversarial">Run</button> <span class="muted">every seeded lie is run through the real gate</span></div>`;
  const rows = a.results.map((r: any) => `<tr><td>${esc(r.surface)}</td><td>${esc(r.name)}</td><td>${esc(r.expected)}</td><td>${esc(r.actual)}</td><td>${badge(r.caught ? 'allowed' : 'conflict', r.caught ? 'CAUGHT' : 'MISSED')}</td></tr>`).join('');
  return `<div class="panel" id="adversarial"><h3>Adversarial harness <button data-action="adversarial">Run again</button></h3><p>${badge(a.uncaught === 0 && a.false_positives === 0 ? 'allowed' : 'conflict', `${a.caught}/${a.total} caught · ${a.false_positives} false positives on ${a.clean_total} clean calls`)}</p>
<table class="t"><thead><tr><th>Surface</th><th>Case</th><th>Expected</th><th>Actual</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

export function metricsView(m: any | null): string {
  return `<section id="metricsview"><div class="panel"><h3>Metrics</h3>${metricsStrip(m)}<p class="muted small">Definitions: stt = end of customer speech → independent final; gate = tool call received → verdict (includes evidence waits); repair = hold → re-validated commit; commit = commit transaction; first audio = end of customer speech → first audible agent audio; barge-in = customer speech onset → reply cut off. p50/p95 are nearest-rank over the stored samples.</p></div></section>`;
}

export const itemsHelp = () => MENU.map((m) => itemName(m.item_id)).join(', ');
