// npm run db:reset : delete the local DB file and recreate schema + seed.
import { rmSync } from 'node:fs';
import { initDatabase } from './connections.js';

const path = process.env.TALLY_DB_PATH ?? './data/tally.sqlite';
for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
initDatabase(path);
console.log(`db reset + seeded: ${path}`);
