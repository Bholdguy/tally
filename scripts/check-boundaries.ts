// Architecture boundary check (ARCHITECTURE §4). Fails the build if:
//  1. /reliability or /contract can reach voice output or the network (Tally has no path to voice; D-09),
//  2. /reliability or /contract import another plane (agent/server/dashboard/demo),
//  3. anything other than reliability/src/committer* imports the read-write DB opener (rule 8),
//  4. /agent (Plane 1) imports the DB package or better-sqlite3 (Plane 1 holds no DB handle).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Violation { file: string; line: number; rule: string; text: string }

const FORBIDDEN_MODULES = /^(ws|undici|http|https|net|tls|dgram|http2|node-fetch|axios|assemblyai|@assemblyai\/.*|node:(http|https|net|tls|dgram|http2))$/;
const OTHER_PLANES = /^@tally\/(agent|server|dashboard|demo|stt)(\/|$)|(^|\/)(agent|server|dashboard|demo|stt)\/src(\/|$)/;
const FORBIDDEN_LITERALS = ['reply.create', 'reply.audio', 'tool.result', 'conversation.message', 'session.update', 'input.audio', 'agents.assemblyai.com'];
const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

function walk(dir: string): string[] {
  let out: string[] = [];
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === 'node_modules' || e === 'dist') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out = out.concat(walk(p));
    else if (/\.(ts|tsx|js|mjs)$/.test(e)) out.push(p);
  }
  return out;
}

function imports(src: string): { spec: string; line: number }[] {
  const res: { spec: string; line: number }[] = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (spec) res.push({ spec, line: src.slice(0, m.index).split('\n').length });
  }
  return res;
}

export function checkBoundaries(root: string): Violation[] {
  const v: Violation[] = [];
  const rel = (f: string) => relative(root, f).split(sep).join('/');

  // 1 + 2: reliability and contract
  for (const pkg of ['reliability', 'contract']) {
    for (const f of walk(join(root, pkg, 'src'))) {
      const src = readFileSync(f, 'utf8');
      for (const { spec, line } of imports(src)) {
        if (FORBIDDEN_MODULES.test(spec)) v.push({ file: rel(f), line, rule: 'no-network-or-voice-module', text: spec });
        if (OTHER_PLANES.test(spec)) v.push({ file: rel(f), line, rule: 'no-cross-plane-import', text: spec });
      }
      src.split('\n').forEach((ln, i) => {
        for (const lit of FORBIDDEN_LITERALS) if (ln.includes(lit)) v.push({ file: rel(f), line: i + 1, rule: 'no-voice-output-reference', text: lit });
      });
    }
  }

  // 2b: /stt (Tally's independent evidence adapters) is input-audio + read-only REST only: no voice output, no other plane, no DB
  for (const f of walk(join(root, 'stt', 'src'))) {
    const src = readFileSync(f, 'utf8');
    for (const { spec, line } of imports(src)) {
      if (/^@tally\/(agent|reliability|server|dashboard|demo|db)(\/|$)/.test(spec) || /(^|\/)(agent|reliability|server|dashboard|demo|db)\/src(\/|$)/.test(spec)) v.push({ file: rel(f), line, rule: 'stt-isolated', text: spec });
      if (/^better-sqlite3(\/|$)/.test(spec)) v.push({ file: rel(f), line, rule: 'stt-isolated', text: spec });
    }
    src.split('\n').forEach((ln, i) => {
      for (const lit of ['reply.create', 'reply.audio', 'tool.result', 'conversation.message', 'session.update', 'agents.assemblyai.com/v1/ws']) {
        if (ln.includes(lit)) v.push({ file: rel(f), line: i + 1, rule: 'stt-no-voice-output-reference', text: lit });
      }
    });
  }

  // 3: read-write opener only from reliability/src/committer*
  for (const pkg of ['reliability', 'agent', 'server', 'dashboard', 'demo', 'contract']) {
    for (const f of walk(join(root, pkg, 'src'))) {
      const r = rel(f);
      if (/^reliability\/src\/committer/.test(r)) continue;
      const src = readFileSync(f, 'utf8');
      src.split('\n').forEach((ln, i) => {
        if (/\bopenCommitter\b/.test(ln)) v.push({ file: r, line: i + 1, rule: 'single-write-path', text: 'openCommitter' });
      });
    }
  }

  // 3b: openAdmin (schema/seed) is db-package-only; mintAllow (the only way to build an AllowDecision) is gate-only
  for (const pkg of ['reliability', 'agent', 'server', 'dashboard', 'demo', 'contract']) {
    for (const f of walk(join(root, pkg, 'src'))) {
      const r = rel(f);
      const src = readFileSync(f, 'utf8');
      src.split('\n').forEach((ln, i) => {
        if (/\bopenAdmin\b/.test(ln)) v.push({ file: r, line: i + 1, rule: 'admin-handle-db-only', text: 'openAdmin' });
        if (/\bmintAllow\b/.test(ln) && !/^reliability\/src\/(gate|decision)/.test(r)) v.push({ file: r, line: i + 1, rule: 'single-allow-path', text: 'mintAllow' });
      });
    }
  }

  // 4: Plane 1 holds no DB handle
  for (const f of walk(join(root, 'agent', 'src'))) {
    for (const { spec, line } of imports(readFileSync(f, 'utf8'))) {
      if (/^(@tally\/db|better-sqlite3)(\/|$)/.test(spec) || /(^|\/)db\/src(\/|$)/.test(spec)) v.push({ file: rel(f), line, rule: 'plane1-no-db', text: spec });
    }
  }
  return v;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const root = process.cwd();
  const violations = checkBoundaries(root);
  if (violations.length) {
    for (const x of violations) console.error(`BOUNDARY VIOLATION [${x.rule}] ${x.file}:${x.line}  ${x.text}`);
    process.exit(1);
  }
  console.log('boundaries OK');
}
