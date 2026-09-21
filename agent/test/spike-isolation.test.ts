import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// The spike pass-through handler has no validation. It must be unreachable from live/demo/replay code (PRD Step 3).
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}

describe('spike stub isolation', () => {
  const roots = ['agent/src', 'reliability/src', 'server/src', 'demo', 'dashboard'].map((r) => join(process.cwd(), r));
  const files = roots.flatMap((r) => { try { return walk(r); } catch { return []; } });

  it('nothing outside agent/src/spike references the pass-through stub', () => {
    const offenders = files.filter((f) => {
      const rel = relative(process.cwd(), f).split(sep).join('/');
      if (rel.startsWith('agent/src/spike/')) return false;
      return /stub-handler|makeSpikePassThrough|SPIKE_STUB_MARKER/.test(readFileSync(f, 'utf8'));
    });
    expect(offenders.map((f) => relative(process.cwd(), f))).toEqual([]);
  });

  it('the stub is labelled spike-only', () => {
    expect(readFileSync(join(process.cwd(), 'agent/src/spike/stub-handler.ts'), 'utf8')).toMatch(/SPIKE ONLY/);
  });
});
