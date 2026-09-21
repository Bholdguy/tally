import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkBoundaries } from '../../scripts/check-boundaries.js';
import { scanSecrets } from '../../scripts/scan-secrets.js';

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'tally-bnd-'));
  for (const [p, c] of Object.entries(files)) {
    const full = join(root, p);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, c);
  }
  return root;
}

describe('boundary script catches seeded violations', () => {
  it('flags a network import inside /reliability', () => {
    const v = checkBoundaries(fixture({ 'reliability/src/x.ts': "import WebSocket from 'ws';\n" }));
    expect(v.map((x) => x.rule)).toContain('no-network-or-voice-module');
  });
  it('flags a voice-output literal inside /reliability and /contract', () => {
    const a = checkBoundaries(fixture({ 'reliability/src/x.ts': "const t = 'reply.create';\n" }));
    const b = checkBoundaries(fixture({ 'contract/src/x.ts': "export const t = 'input.audio';\n" }));
    expect(a.map((x) => x.rule)).toContain('no-voice-output-reference');
    expect(b.map((x) => x.rule)).toContain('no-voice-output-reference');
  });
  it('flags a cross-plane import from /reliability into /agent', () => {
    const v = checkBoundaries(fixture({ 'reliability/src/x.ts': "import { a } from '@tally/agent';\n" }));
    expect(v.map((x) => x.rule)).toContain('no-cross-plane-import');
  });
  it('flags openCommitter used outside committer', () => {
    const v = checkBoundaries(fixture({ 'server/src/x.ts': "import { openCommitter } from '@tally/db';\n" }));
    expect(v.map((x) => x.rule)).toContain('single-write-path');
  });
  it('allows openCommitter inside reliability/src/committer', () => {
    const v = checkBoundaries(fixture({ 'reliability/src/committer.ts': "import { openCommitter } from '@tally/db';\n" }));
    expect(v.filter((x) => x.rule === 'single-write-path')).toHaveLength(0);
  });
  it('flags openAdmin outside /db and mintAllow outside the gate', () => {
    const v = checkBoundaries(fixture({
      'server/src/x.ts': "import { openAdmin } from '@tally/db';\n",
      'reliability/src/repair.ts': "import { mintAllow } from './decision.js';\n",
    }));
    expect(v.map((x) => x.rule)).toEqual(expect.arrayContaining(['admin-handle-db-only', 'single-allow-path']));
  });
  it('allows mintAllow inside the gate', () => {
    const v = checkBoundaries(fixture({ 'reliability/src/gate.ts': "import { mintAllow } from './decision.js';\n" }));
    expect(v.filter((x) => x.rule === 'single-allow-path')).toHaveLength(0);
  });
  it('flags /reliability importing /stt (network adapter) and /stt reaching other planes or voice output', () => {
    expect(checkBoundaries(fixture({ 'reliability/src/x.ts': "import { SttStream } from '@tally/stt';\n" })).map((x) => x.rule)).toContain('no-cross-plane-import');
    expect(checkBoundaries(fixture({ 'stt/src/x.ts': "import { Store } from '@tally/reliability';\n" })).map((x) => x.rule)).toContain('stt-isolated');
    expect(checkBoundaries(fixture({ 'stt/src/x.ts': "const t = 'reply.create';\n" })).map((x) => x.rule)).toContain('stt-no-voice-output-reference');
  });
  it('allows /stt to use ws (it is an audio-in adapter)', () => {
    expect(checkBoundaries(fixture({ 'stt/src/x.ts': "import WebSocket from 'ws';\n" }))).toEqual([]);
  });
  it('flags Plane 1 importing the DB', () => {
    const v = checkBoundaries(fixture({ 'agent/src/x.ts': "import Database from 'better-sqlite3';\n" }));
    expect(v.map((x) => x.rule)).toContain('plane1-no-db');
  });
  it('the real repo is clean', () => {
    expect(checkBoundaries(process.cwd())).toEqual([]);
  });
});

describe('secret scan', () => {
  it('finds a literal key and a key assignment', () => {
    // built at runtime so this test file itself never contains a key-shaped literal
    const key = ['abcdef', '1234567890', 'abcdef'].join('');
    const root = fixture({ 'a/client.ts': `const k = '${key}';\n`, 'b.md': `ASSEMBLYAI_API_KEY${'='}${key}\n` });
    const kinds = scanSecrets(root, key).map((f) => f.kind);
    expect(kinds).toContain('literal-api-key');
    expect(kinds).toContain('assemblyai-key-assignment');
  });
  it('the real repo is clean (.env.example has no values)', () => {
    expect(scanSecrets(process.cwd())).toEqual([]);
  });
});
