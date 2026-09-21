// Spoken-state drift check (rule 3, brief §1.3): the agent's spoken confirmation is NEVER ground truth. After the agent
// speaks, compare what it CLAIMED (item, quantity, total) with the committed order. Can only RAISE findings.
import { computeTotalCents, type OrderLine } from '@tally/contract';
import { claimedItems } from './extractor.js';

export interface DriftFinding { code: 'SPOKEN_STATE_DRIFT' | 'TOTAL_MISMATCH'; detail: string; item_id?: string; /** what the committed order actually has: the repair states THIS, never the agent's version */ actual_quantity?: number; actual_total_cents?: number }
export interface DriftOrderView { lines: readonly OrderLine[]; total_cents: number }

// a sentence that states a commitment about the order (as opposed to asking a question)
const COMMITS = /\b(i('| ha)ve|i've|got|added|adding|updated|you have|you've got|your order|okay|ok|so)\b/i;

/**
 * Work bound (found by the adversarial harness): claim extraction is super-linear in the length of one sentence, so an unbounded agent
 * reply (the agent is untrusted, and may be prompt-injected into emitting a huge one) could stall the event loop for many seconds.
 * The first MAX_TEXT characters are checked, split into sentences capped at MAX_SENTENCE. A wrong claim beyond that is NOT checked: a
 * documented limit, safe because speech never changes the order.
 */
export const MAX_TEXT = 4000;
export const MAX_SENTENCE = 400;
const sentencesOf = (t: string): string[] => t.slice(0, MAX_TEXT).split(/(?<=[.!?])\s+/).map((s) => s.trim().slice(0, MAX_SENTENCE)).filter(Boolean);

export function checkSpokenDrift(agentText: string, order: DriftOrderView): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const sentences = sentencesOf(agentText);
  for (const s of sentences) {
    if (s.endsWith('?')) continue; // questions and offers make no claim about the order
    for (const c of claimedItems(s)) {
      if (!c.explicit || c.quantity === null) continue;
      const line = order.lines.find((l) => l.item_id === c.item_id);
      if (line && line.quantity !== c.quantity) {
        findings.push({ code: 'SPOKEN_STATE_DRIFT', item_id: c.item_id, actual_quantity: line.quantity, detail: `agent said ${c.quantity} ${c.item_id}, the order has ${line.quantity}` });
      } else if (!line && COMMITS.test(s)) {
        findings.push({ code: 'SPOKEN_STATE_DRIFT', item_id: c.item_id, detail: `agent said ${c.quantity} ${c.item_id}, which is not on the order` });
      }
    }
    const m = /\$\s?(\d+)(?:\.(\d{1,2}))?/.exec(s);
    if (m) {
      const said = Number(m[1]) * 100 + (m[2] ? Number((m[2] + '0').slice(0, 2)) : 0);
      const actual = computeTotalCents(order.lines);
      if (said !== actual) findings.push({ code: 'TOTAL_MISMATCH', actual_total_cents: actual, detail: `agent said $${(said / 100).toFixed(2)}, the recomputed total is $${(actual / 100).toFixed(2)}` });
    }
  }
  return findings;
}

/**
 * Did this utterance state `scope` CORRECTLY? ('order' = the total; otherwise an item's quantity.) Used to resolve an open spoken-drift
 * repair when the agent's later speech matches the committed order. A statement that also drifts on that scope does not count.
 */
export function statesScopeCorrectly(agentText: string, order: DriftOrderView, scope: string): boolean {
  const sentences = sentencesOf(agentText).filter((s) => !s.endsWith('?'));
  if (scope === 'order') {
    const actual = computeTotalCents(order.lines);
    return sentences.some((s) => {
      const m = /\$\s?(\d+)(?:\.(\d{1,2}))?/.exec(s);
      return !!m && Number(m[1]) * 100 + (m[2] ? Number((m[2] + '0').slice(0, 2)) : 0) === actual;
    });
  }
  const line = order.lines.find((l) => l.item_id === scope);
  return sentences.some((s) => claimedItems(s).some((c) => c.item_id === scope && c.explicit && c.quantity !== null && !!line && c.quantity === line.quantity));
}
