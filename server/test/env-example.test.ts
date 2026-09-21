// .env.example must not lie: every variable it lists is read by the code, and every variable the code reads is listed.
// (An audit found seven listed variables that did nothing and two read variables that were missing.)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const walk = (d: string, out: string[] = []): string[] => { for (const e of readdirSync(d)) { if (['node_modules', 'dist', 'data', 'test', 'fixtures'].includes(e)) continue; const p = join(d, e); statSync(p).isDirectory() ? walk(p, out) : /\.ts$/.test(e) && !/[\/]scripts[\/]_/.test(p) && out.push(p); } return out; };
const code = ['contract', 'db', 'reliability', 'agent', 'stt', 'server', 'scripts'].flatMap((d) => walk(join(process.cwd(), d))).map((f) => readFileSync(f, 'utf8')).join('\n');
const example = readFileSync(join(process.cwd(), '.env.example'), 'utf8');
const listed = [...example.matchAll(/^([A-Z][A-Z0-9_]+)=(.*)$/gm)].map((m) => ({ name: m[1]!, value: m[2]!.trim() }));
const readByCode = new Set([...code.matchAll(/(?:process\.env|env)\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]!)
  .concat([...code.matchAll(/(?:num|str|flag)\('([A-Z][A-Z0-9_]+)'/g)].map((m) => m[1]!))
  .concat([...code.matchAll(/env\['([A-Z][A-Z0-9_]+)'\]/g)].map((m) => m[1]!)));

describe('.env.example matches the code', () => {
  it('every listed variable is actually read', () => {
    expect(listed.length).toBeGreaterThan(10);
    expect(listed.filter((v) => !readByCode.has(v.name)).map((v) => v.name)).toEqual([]);
  });
  it('every variable the code reads is listed (except ones only a test or a live script sets)', () => {
    const names = new Set(listed.map((v) => v.name));
    expect([...readByCode].filter((n) => !names.has(n))).toEqual([]);
  });
  it('secrets are blank; the documented defaults equal the code\'s defaults', () => {
    for (const v of listed.filter((x) => /(KEY|TOKEN|SECRET|PASSWORD)$/.test(x.name))) expect(v.value, v.name).toBe('');
    const val = (n: string) => listed.find((x) => x.name === n)!.value;
    expect(val('EVIDENCE_WAIT_MAX_MS')).toBe('4000'); expect(val('STT_STALL_MS')).toBe('2500'); expect(val('MIN_WORD_CONFIDENCE')).toBe('0.6');
    expect(val('REGRESSION_THRESHOLD')).toBe('3'); expect(val('LOCAL_VAD_HANGOVER_MS')).toBe('300'); expect(val('PORT')).toBe('8787'); expect(val('HOST')).toBe('127.0.0.1');
  });
});
