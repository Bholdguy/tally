import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MENU, MODIFIER_PRICE_DELTAS } from '@tally/contract';

export type Db = Database.Database;

const SCHEMA_PATH = fileURLToPath(new URL('../schema.sql', import.meta.url));
export const SCHEMA_VERSION = '7';

/** Columns added after v1. CREATE TABLE IF NOT EXISTS never alters an existing table, so upgrade in place. */
const ADDED_COLUMNS: [table: string, column: string, ddl: string][] = [
  ['events_raw', 'server_ts_ms', 'REAL'],
  ['utterances', 'source', "TEXT NOT NULL DEFAULT 'agent_stream'"],
  ['utterances', 'server_ts_ms', 'REAL'],
  ['utterances', 'words_json', 'TEXT'],
  ['vad_events', 'source', "TEXT NOT NULL DEFAULT 'agent'"],
  ['vad_events', 'reaction_ms', 'REAL'],
  ['repair_events', 'scope', "TEXT NOT NULL DEFAULT 'order'"],
  ['repair_events', 'alt_scope', 'TEXT'],
  ['cases', 'resolution', "TEXT NOT NULL DEFAULT 'open'"],
  ['cases', 'accepted_by', 'TEXT'],
  ['replay_runs', 'duration_ms', 'REAL'],
  ['sessions', 'intent_json', 'TEXT'],
];

function ensureColumns(db: Db): void {
  for (const [table, column, ddl] of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

function tune(db: Db): Db {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

/** Everyone reads through this. It physically cannot write. */
export function openReadonly(path: string): Db {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.pragma('foreign_keys = ON');
  return db;
}

/**
 * The ONLY read-write handle for application code. Exported for reliability/src/committer* alone;
 * `npm run check:boundaries` fails the build if any other module references it (rule 8).
 */
export function openCommitter(path: string): Db {
  return tune(new Database(path, { fileMustExist: true }));
}

/** Schema/seed only (migrations, tests, db:reset). Never used by a runtime plane; boundary script bans it outside /db. */
export function openAdmin(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  return tune(new Database(path));
}

export function applySchema(db: Db): void {
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  ensureColumns(db);
  db.prepare("INSERT INTO schema_meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(SCHEMA_VERSION);
}

/** Idempotent: safe to run any number of times; converges to exactly the contract menu. */
export function seedMenu(db: Db): void {
  const up = db.prepare(
    `INSERT INTO menu(item_id,name,price_cents,aliases_json,modifiers_json) VALUES(@item_id,@name,@price_cents,@aliases_json,@modifiers_json)
     ON CONFLICT(item_id) DO UPDATE SET name=excluded.name, price_cents=excluded.price_cents, aliases_json=excluded.aliases_json, modifiers_json=excluded.modifiers_json`,
  );
  db.transaction(() => {
    for (const m of MENU) {
      up.run({
        item_id: m.item_id, name: m.name, price_cents: m.price_cents,
        aliases_json: JSON.stringify(m.aliases),
        modifiers_json: JSON.stringify(m.modifiers.map((id) => ({ id, price_delta_cents: MODIFIER_PRICE_DELTAS[id] ?? 0 }))),
      });
    }
  })();
}

/** Create/upgrade the DB file: schema + seed. Uses and closes an admin handle; returns nothing. */
export function initDatabase(path: string): void {
  const db = openAdmin(path);
  try {
    applySchema(db);
    seedMenu(db);
  } finally {
    db.close();
  }
}
