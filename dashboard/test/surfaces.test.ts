// STEP 13, the "eight-defect class" final pass (DECISIONS D-28): a value that should not reach a user-facing surface unfiltered.
// Operator surfaces are rendered from the REAL event streams and stored-case shapes; internal item/option ids must appear as words, and
// hostile or unknown values must appear escaped (or not at all). The customer-audible half of the pass is reliability/test/spoken-audit.test.ts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_MODIFIERS, MENU } from '@tally/contract';
import { reduceAll, type Ev } from '../src/state.js';
import { callLog, callTable, casesView, compareTable, liveView, orderPanel, transcripts } from '../src/views.js';

const load = (n: string): Ev[] => JSON.parse(readFileSync(join(process.cwd(), 'dashboard/test/fixtures', `${n}.events.json`), 'utf8'));
const visible = (html: string) => html.replace(/<title>[^<]*<\/title>/g, '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ');
/** machine vocabulary an operator legitimately sees: tool names, ids of sessions/cases/events, pattern keys (their parts are tool/code names) */
const MACHINE = new Set(['add_item', 'remove_item', 'update_quantity', 'apply_modifier', 'confirm_order', 'get_order_state', 'agent_speech']);
const ids = new Set<string>([...MENU.map((m) => m.item_id), ...ALL_MODIFIERS].filter((x) => x.includes('_')));

const UI = { now: 0, scenarios: [], mic: false, busy: null, sessions: [], role: 'operator' as const };

describe('no internal item or option id reaches an operator surface', () => {
  for (const name of ['A', 'B', 'dropout', 'confidence']) {
    it(`scenario ${name}: the live view (timeline, call log, order panel, transcripts, call table) shows names, not ids`, () => {
      const s = reduceAll(load(name));
      const html = [liveView(s, UI), callLog(s), callTable(s), orderPanel(s.order), transcripts(s)].join(' ');
      const text = visible(html);
      for (const id of ids) expect(text, `raw id ${id}`).not.toContain(id);
      const stray = [...text.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)].map((m) => m[0]).filter((w) => !MACHINE.has(w) && !/^(sess|case|rt|demo|scripted|adv)_/.test(w));
      expect(stray).toEqual([]);
    });
  }

  it('every menu item and modifier, put on the order panel and in a call, is rendered in words', () => {
    for (const m of MENU) {
      const order = orderPanel({ lines: [{ item_id: m.item_id, quantity: 2, modifiers: [...m.modifiers] }], total_cents: 1000, status: 'open' });
      const call = reduceAll([{ id: 'e', session_id: 's', kind: 'verdict', t_ms: 1, wall_ms: 1, aai_call_id: 'c', tool: 'add_item', args: { item_id: m.item_id, quantity: 2, modifiers: m.modifiers }, verdict: 'ALLOW' }]);
      const text = visible(order + callLog(call));
      for (const id of [m.item_id, ...m.modifiers]) if (id.includes('_')) expect(text, `${m.item_id}: ${id}`).not.toContain(id);
    }
  });
});

describe('hostile or unknown values are neutralised', () => {
  it('an agent-supplied item id / tool name that is not on the menu is shown as "that item" or escaped, never as markup or an attacker-chosen string in the call log', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const s = reduceAll([{ id: 'e', session_id: 's', kind: 'verdict', t_ms: 1, wall_ms: 1, aai_call_id: 'c', tool: evil, args: { item_id: evil, quantity: 2, modifier: evil, pickup_time: evil }, verdict: 'HOLD', code: 'SCHEMA_INVALID' }]);
    const html = [callLog(s), callTable(s), liveView(s, UI)].join('');
    expect(html).not.toContain('<img');
    expect(visible(callLog(s))).not.toContain('onerror');                        // the item, option and pickup values are replaced by words; only the (escaped) tool name is echoed
    expect(visible(callLog(s))).toContain('that item');
  });

  it('a stored case with hostile fields renders inert (case list, detail, compare)', () => {
    const evil = '"><script>alert(1)</script>';
    const html = casesView([{ id: evil, conflict_type: evil, pattern_key: evil, tag: evil, resolution: evil, origin_mode: evil }],
      { id: evil, conflict_type: evil, pattern_key: evil, tag: evil, resolution: evil, transcript_snapshot: evil, event_snapshot: { call: { tool: evil, args: { x: evil } }, order_before: { lines: [] }, events: [{ kind: 'evidence_transcript', t_ms: 1, text: evil }] }, expected_state: null }, null, null, 'operator')
      + compareTable([{ case_id: evil, pattern_key: evil, tag: evil, by_version: { v1: { evidence: 'pass', audio: evil } } }], ['v1']);
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;');                                       // present, as text
  });

  it('numbers that are not numbers do not break the view (NaN, null, huge, negative)', () => {
    for (const v of [NaN, null, undefined, 1e21, -5, Infinity]) expect(() => orderPanel({ lines: [{ item_id: 'burger', quantity: v as never, modifiers: [] }], total_cents: v as never, status: 'open' })).not.toThrow();
  });
});
