// Secret scan (SECURITY §7): literal key from env + generic patterns across repo and dashboard/dist.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Finding { file: string; line: number; kind: string }

const SKIP_DIRS = new Set(['node_modules', '.git', 'data']);
const SKIP_FILES = new Set(['package-lock.json']);
const TEXT_EXT = /\.(ts|tsx|js|mjs|json|md|html|css|sql|env|example|yml|yaml|ps1|txt)$/i;
// Generic patterns: assignment of a long token to a key-ish name, bearer tokens, private key blocks.
const PATTERNS: [string, RegExp][] = [
  ['assemblyai-key-assignment', /ASSEMBLYAI_API_KEY\s*[=:]\s*['"]?[A-Za-z0-9_-]{16,}/],
  ['bearer-token', /Bearer\s+[A-Za-z0-9._-]{24,}/],
  ['private-key', /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['generic-api-key', /(api[_-]?key|secret|token)['"]?\s*[:=]\s*['"][A-Za-z0-9_-]{24,}['"]/i],
];

function walk(dir: string): string[] {
  let out: string[] = [];
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out = out.concat(walk(p));
    else if (!SKIP_FILES.has(e) && (TEXT_EXT.test(e) || e === '.env' || e === '.env.example')) out.push(p);
  }
  return out;
}

export function scanSecrets(root: string, literalKey?: string): Finding[] {
  const res: Finding[] = [];
  for (const f of walk(root)) {
    const r = relative(root, f).split(sep).join('/');
    if (r === '.env') continue; // the real env file is git-ignored by design; never scanned or reported here
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((ln, i) => {
      if (literalKey && literalKey.length >= 8 && ln.includes(literalKey)) res.push({ file: r, line: i + 1, kind: 'literal-api-key' });
      for (const [kind, re] of PATTERNS) if (re.test(ln)) res.push({ file: r, line: i + 1, kind });
    });
  }
  return res;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const found = scanSecrets(process.cwd(), process.env.ASSEMBLYAI_API_KEY);
  if (found.length) {
    for (const x of found) console.error(`SECRET FINDING [${x.kind}] ${x.file}:${x.line}`);
    process.exit(1);
  }
  console.log('secret scan OK');
}
