import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MENU } from '@tally/contract';
import { applySchema, initDatabase, openAdmin, openReadonly, seedMenu } from '../src/index.js';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'tally-db-')), 't.sqlite');
const hash = (rows: unknown) => createHash('sha256').update(JSON.stringify(rows)).digest('hex');

describe('seed', () => {
  it('is idempotent: running twice yields identical menu rows and counts', () => {
    const p = tmp();
    initDatabase(p);
    const db1 = openReadonly(p);
    const a = db1.prepare('SELECT * FROM menu ORDER BY item_id').all();
    db1.close();
    initDatabase(p);
    initDatabase(p);
    const db2 = openReadonly(p);
    const b = db2.prepare('SELECT * FROM menu ORDER BY item_id').all();
    db2.close();
    expect(a).toHaveLength(12);
    expect(hash(b)).toBe(hash(a));
  });
  it('seeds exactly the contract menu with modifier deltas', () => {
    const p = tmp();
    initDatabase(p);
    const db = openReadonly(p);
    const rows = db.prepare('SELECT * FROM menu').all() as { item_id: string; price_cents: number; modifiers_json: string }[];
    expect(rows.map((r) => r.item_id).sort()).toEqual(MENU.map((m) => m.item_id).sort());
    const burger = rows.find((r) => r.item_id === 'burger')!;
    expect(burger.price_cents).toBe(899);
    expect(JSON.parse(burger.modifiers_json).find((m: any) => m.id === 'extra_cheese').price_delta_cents).toBe(100);
    db.close();
  });
  it('re-seeding repairs a drifted menu row', () => {
    const p = tmp();
    initDatabase(p);
    const admin = openAdmin(p);
    admin.prepare("UPDATE menu SET price_cents=1 WHERE item_id='burger'").run();
    seedMenu(admin);
    expect((admin.prepare("SELECT price_cents FROM menu WHERE item_id='burger'").get() as any).price_cents).toBe(899);
    admin.close();
  });
  it('applySchema is re-runnable', () => {
    const db = openAdmin(':memory:');
    applySchema(db);
    expect(() => applySchema(db)).not.toThrow();
    db.close();
  });
});

describe('read-only handle', () => {
  it('cannot write', () => {
    const p = tmp();
    initDatabase(p);
    const ro = openReadonly(p);
    expect(() => ro.prepare("UPDATE menu SET price_cents=1 WHERE item_id='burger'").run()).toThrow(/readonly/i);
    ro.close();
  });
});

describe('queryable', () => {
  it('has all tables from PRD §B.10', () => {
    const p = tmp();
    initDatabase(p);
    const db = openReadonly(p);
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    for (const t of ['sessions', 'utterances', 'vad_events', 'entities', 'tool_calls', 'repair_events', 'cases', 'replay_runs', 'configs', 'audit_events', 'orders', 'menu', 'metrics_samples', 'events_raw']) {
      expect(names, t).toContain(t);
    }
    db.close();
  });
  it('barge_in vad rows must be derived', () => {
    const db = openAdmin(':memory:');
    applySchema(db);
    db.prepare("INSERT INTO configs(id,version,prompt_hash,tool_schema_hash,created_at,prompt_text,tool_schema_json) VALUES('c','v1','h','h',1,'p','[]')").run();
    db.prepare("INSERT INTO sessions(id,started_at,agent_config_version,mode) VALUES('s',1,'v1','live')").run();
    expect(() => db.prepare("INSERT INTO vad_events(id,session_id,type,timestamp,t_ms,derived) VALUES('v','s','barge_in',1,1,0)").run()).toThrow();
    expect(() => db.prepare("INSERT INTO vad_events(id,session_id,type,timestamp,t_ms,derived,source_event_ids) VALUES('v','s','barge_in',1,1,1,'[\"a\",\"b\"]')").run()).not.toThrow();
    db.close();
  });
});
