// The demo seed (demo lock): run the actual script into a fresh database and check what a stage demo relies on: real cases from the
// pipeline, one operator-accepted regression, and a promotion gate that BLOCKS a weakened config by naming that case (not a vacuous pass).
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '@tally/reliability';
import { runSuite } from '@tally/reliability';

describe('npm run demo:seed', () => {
  it('leaves a database with real cases, exactly one operator-accepted regression, v2 BLOCKED naming it, and v3 passing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-seed-'));
    const db = join(dir, 'tally.sqlite');
    const r = spawnSync('npx', ['tsx', 'scripts/demo-seed.ts', `--db=${db}`, '--fresh'], { cwd: process.cwd(), shell: true, encoding: 'utf8', timeout: 240000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/operator accepted case/);
    expect(r.stdout).toMatch(/suite for v2: BLOCKED/);
    expect(r.stdout).toMatch(/suite for v3: PASSED/);

    const s = new Store(db);
    try {
      const counts = s.caseCounts();
      expect(counts).toMatchObject({ regressions: 1 });
      expect(counts.cases).toBeGreaterThanOrEqual(7);
      // every case came out of the pipeline: it has a real recording on disk, stored events, and a session that ran
      for (const c of s.listCases()) {
        const row = s.getCase(c.id)!;
        expect(row.audio_pointer).toBeTruthy();
        expect(s.sessionEvents(row.session_id).length).toBeGreaterThan(5);
        expect(row.origin_mode).toBe('demo');
      }
      const reg = s.listCases({ tag: 'regression' });
      expect(reg).toHaveLength(1);
      expect(s.getCase(reg[0]!.id)).toMatchObject({ resolution: 'resolved', accepted_by: 'operator' });
      expect(reg[0]!.pattern_key).toContain('low_confidence');
      // the acceptance is audit-logged as an operator action
      expect((s.r.prepare("SELECT count(*) n FROM audit_events WHERE action='accept_regression' AND actor='operator'").get() as { n: number }).n).toBe(1);
      // the gate has something real to block against, and names it
      expect(s.activeConfig()!.version).toBe('v1');
      const blocked = await runSuite(s, { config_version: 'v2' });
      expect(blocked.status).toBe('blocked');
      expect(blocked.vacuous).toBe(false);
      expect(blocked.blocking).toEqual([expect.objectContaining({ case_id: reg[0]!.id, reason: 'SAFETY_REGRESSION_now_allowed_but_must_be_held' })]);
      const passing = await runSuite(s, { config_version: 'v3' });
      expect(passing).toMatchObject({ status: 'passed', vacuous: false, suite_size: 1 });
      expect(s.activateConfig('v3', passing.suite_run_id).previous).toBe('v1');
    } finally { s.close(); }
  }, 300000);
});
