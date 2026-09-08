// Migration runner. Applies db/migrations/*.sql in filename order, once each.
//
// Deliberately minimal: no down-migrations, no ORM, no framework. Migrations
// are plain SQL so they can be read, reviewed and run by hand against any
// Postgres, including the production one, without this script.

import { readdir, readFile } from 'node:fs/promises';
import { query, exec, close, driverName } from '../lib/db.js';

const DIR = new URL('../db/migrations/', import.meta.url);

export async function migrate({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...a) => console.log(...a);

  await query(`
    create table if not exists schema_migration (
      name        text        primary key,
      applied_at  timestamptz not null default now()
    )
  `);

  const applied = new Set(
    (await query('select name from schema_migration')).rows.map((r) => r.name),
  );

  const files = (await readdir(DIR)).filter((f) => f.endsWith('.sql')).sort();
  const ran = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(new URL(file, DIR), 'utf8');
    // A migration is a batch of statements, so it goes through exec() rather
    // than query() — PGlite's query() accepts exactly one statement. A failure
    // aborts the run and leaves the migration unrecorded, so re-running
    // retries from the same file.
    await exec(sql);
    await query('insert into schema_migration (name) values ($1)', [file]);
    ran.push(file);
    log(`applied ${file}`);
  }

  if (!ran.length) log('up to date');
  return ran;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`driver: ${await driverName()}`);
  await migrate();
  await close();
}
