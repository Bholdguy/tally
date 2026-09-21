// The evidence timeline (brief §11): a static SVG, three lanes on one time axis. Layout is PURE geometry over LiveState so it is testable.
//   Lane 1 Customer speech : local speech segments (what the microphone heard); ticks = the independent stream heard speech start; ◆ = derived barge-in
//   Lane 2 Agent speech    : audible agent replies (interrupted ones marked)
//   Lane 3 Tool calls      : one bar per gated call, from the call to its verdict; colour AND text label
import { esc } from './escape.js';
import { statusLabel, type CallStatus, type LiveState } from './state.js';

export interface Shape { lane: 0 | 1 | 2; x: number; w: number; cls: string; label: string; title: string }
export interface Diamond { x: number; y: number; title: string }
export interface Layout { width: number; height: number; span_ms: number; lanes: { label: string; y: number }[]; shapes: Shape[]; ticks: { x: number; y: number; title: string }[]; diamonds: Diamond[]; axis: { x: number; label: string }[] }

const LEFT = 130; const LANE_H = 44; const TOP = 22;
export const CLASS_OF: Record<CallStatus, string> = { allowed: 'ok', repaired: 'repaired', noop: 'ok', conflict: 'bad', held: 'bad', waiting: 'wait', pending: 'wait' };

export function layout(s: LiveState, width = 900): Layout {
  const span = Math.max(3000, s.t_max + 500);
  const usable = width - LEFT - 10;
  const x = (t: number) => LEFT + (Math.max(0, t) / span) * usable;
  const seg = (start: number, end: number | null) => { const a = x(start); const b = x(end ?? s.t_max); return { x: a, w: Math.max(3, b - a) }; };
  const shapes: Shape[] = [];
  for (const c of s.customer) shapes.push({ lane: 0, ...seg(c.start, c.end), cls: 'speech', label: '', title: `customer speech ${(c.start / 1000).toFixed(1)} s${c.end === null ? ' → (ongoing)' : ` → ${(c.end / 1000).toFixed(1)} s`}` });
  for (const a of s.agent) shapes.push({ lane: 1, ...seg(a.start, a.end), cls: a.interrupted ? 'agent interrupted' : 'agent', label: a.interrupted ? 'cut off' : '', title: `agent speaking ${(a.start / 1000).toFixed(1)} s${a.interrupted ? ' (interrupted)' : ''}` });
  for (const c of s.calls) {
    const lbl = statusLabel(c);
    shapes.push({ lane: 2, ...seg(c.start, c.end), cls: CLASS_OF[c.status], label: lbl, title: `${c.tool} · ${lbl}${typeof c.waited_ms === 'number' ? ` · ${(c.waited_ms / 1000).toFixed(1)} s` : ''}` });
  }
  const y = (lane: number) => TOP + lane * LANE_H;
  const axis: { x: number; label: string }[] = [];
  const step = span > 60000 ? 10000 : span > 20000 ? 5000 : 1000;
  for (let t = 0; t <= span; t += step) axis.push({ x: x(t), label: `${t / 1000}s` });
  return {
    width, height: TOP + 3 * LANE_H + 22, span_ms: span, axis, shapes,
    lanes: [{ label: 'Customer speech', y: y(0) }, { label: 'Agent speech', y: y(1) }, { label: 'Tool calls', y: y(2) }],
    ticks: s.independent.map((t) => ({ x: x(t), y: y(0), title: `independent stream heard speech start · ${(t / 1000).toFixed(1)} s` })),
    diamonds: s.bargeIns.map((b) => ({ x: x(b.t), y: y(0) + 30, title: `barge-in (derived) · source events ${b.ids.join(' + ')}${b.reaction_ms !== undefined ? ` · reaction ${Math.round(b.reaction_ms)} ms` : ''}` })),
  };
}

export function renderSvg(l: Layout): string {
  const parts: string[] = [`<svg class="timeline" role="img" aria-label="evidence timeline" viewBox="0 0 ${l.width} ${l.height}" width="100%" preserveAspectRatio="xMinYMin meet">`];
  for (const a of l.axis) parts.push(`<line class="grid" x1="${a.x.toFixed(1)}" y1="14" x2="${a.x.toFixed(1)}" y2="${l.height - 22}"/><text class="axis" x="${a.x.toFixed(1)}" y="${l.height - 6}">${esc(a.label)}</text>`);
  for (const ln of l.lanes) parts.push(`<text class="lane" x="4" y="${ln.y + 22}">${esc(ln.label)}</text>`);
  for (const sh of l.shapes) {
    const y = l.lanes[sh.lane]!.y + 6;
    parts.push(`<g class="shape ${esc(sh.cls)}"><title>${esc(sh.title)}</title><rect x="${sh.x.toFixed(1)}" y="${y}" width="${sh.w.toFixed(1)}" height="26" rx="3"/>${sh.label ? `<text x="${(sh.x + 4).toFixed(1)}" y="${y + 17}">${esc(sh.label)}</text>` : ''}</g>`);
  }
  for (const t of l.ticks) parts.push(`<g class="tick"><title>${esc(t.title)}</title><line x1="${t.x.toFixed(1)}" y1="${t.y + 2}" x2="${t.x.toFixed(1)}" y2="${t.y + 38}"/></g>`);
  for (const d of l.diamonds) parts.push(`<g class="barge"><title>${esc(d.title)}</title><path d="M${d.x.toFixed(1)} ${d.y - 7} l7 7 l-7 7 l-7 -7 z"/></g>`);
  parts.push('</svg>');
  return parts.join('');
}
