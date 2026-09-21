// Regenerates dashboard/test/fixtures/*.events.json: the REAL event streams (from the deterministic demo pipeline) that the dashboard's
// reducer and UI tests replay. Run it after changing the event contract: npx tsx scripts/capture-demo-events.ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase } from '../db/src/index.js';
import { Store } from '../reliability/src/committer.js';
import { runScenario, type ScenarioName } from '../server/src/demo/scenarios.js';

for (const name of ['A', 'B', 'dropout', 'confidence'] as ScenarioName[]) {
  const dir = mkdtempSync(join(tmpdir(), 'tally-cap-'));
  initDatabase(join(dir, 'd.sqlite'));
  const store = new Store(join(dir, 'd.sqlite'));
  const events: unknown[] = [];
  await runScenario(name, { store, audioDir: join(dir, 'audio'), onEvent: (e) => { const { raw: _raw, ...rest } = e as typeof e & { raw?: unknown }; events.push(rest); } });
  writeFileSync(`dashboard/test/fixtures/${name}.events.json`, JSON.stringify(events));
  console.log(name, events.length, 'events');
  store.close();
}
