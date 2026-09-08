// Database access, with one interface over two drivers.
//
// Local development and tests run PGlite — Postgres compiled to WebAssembly,
// running in this process against a directory on disk. No server, no account,
// no network. Production runs Neon over its serverless driver.
//
// Both speak the same SQL and both expose `query(text, params) -> { rows }`,
// so nothing above this file knows which one it is talking to. That is the
// point: the schema and every query are written once and are portable.
//
//   DATABASE_URL set  -> Neon
//   otherwise         -> PGlite in ./.data/pg (override with PGLITE_DIR)

let impl = null;

async function connect() {
  const url = process.env.DATABASE_URL;

  if (url) {
    const { Pool } = await import('@neondatabase/serverless');
    const pool = new Pool({ connectionString: url });
    return {
      driver: 'neon',
      query: (text, params) => pool.query(text, params),
      // A transaction must run on ONE connection. pool.query() may hand out a
      // different one per call, so BEGIN/COMMIT issued through it would apply
      // to unrelated connections. Check out a client explicitly.
      transaction: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query('begin');
          const out = await fn({ query: (t, p) => client.query(t, p) });
          await client.query('commit');
          return out;
        } catch (err) {
          await client.query('rollback').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      },
      // Parameterless queries use the simple query protocol, which accepts a
      // batch of statements separated by semicolons.
      exec: (text) => pool.query(text),
      close: () => pool.end(),
    };
  }

  // PGlite is a devDependency and is absent from a production build on
  // purpose: Vercel's filesystem is ephemeral, so a local database file there
  // would vanish between invocations. Say that plainly rather than surfacing a
  // module-resolution stack trace.
  let PGlite;
  try {
    ({ PGlite } = await import('@electric-sql/pglite'));
  } catch {
    throw new Error(
      'No DATABASE_URL is set and PGlite is unavailable. Set DATABASE_URL to a '
      + 'hosted Postgres — a serverless deployment has no persistent disk for a '
      + 'local database file.',
    );
  }
  const { mkdirSync } = await import('node:fs');
  const dir = process.env.PGLITE_DIR || new URL('../.data/pg', import.meta.url).pathname;
  // PGlite creates its data directory but not the parents above it.
  mkdirSync(dir, { recursive: true });
  const pg = await PGlite.create(dir);
  return {
    driver: 'pglite',
    query: (text, params) => pg.query(text, params),
    // PGlite's query() is strictly one statement; exec() runs a batch.
    exec: (text) => pg.exec(text),
    transaction: (fn) => pg.transaction((tx) => fn({ query: (t, p) => tx.query(t, p) })),
    close: () => pg.close(),
  };
}

export async function db() {
  if (!impl) impl = await connect();
  return impl;
}

export async function query(text, params) {
  return (await db()).query(text, params);
}

/** Run a batch of semicolon-separated statements. Used by migrations. */
export async function exec(text) {
  return (await db()).exec(text);
}

/**
 * Run `fn` inside a transaction, passing it a { query } handle.
 *
 * Every write in an ingest goes through one of these. Beyond atomicity — a
 * failed load must not leave a source half-written — it collapses hundreds of
 * individual commits into one, which is the difference between a backfill
 * taking minutes and taking hours.
 */
export async function transaction(fn) {
  return (await db()).transaction(fn);
}

/** Rows only, for the common case. */
export async function rows(text, params) {
  return (await query(text, params)).rows;
}

/** Exactly one row, or null. Throws if the query returns more than one. */
export async function one(text, params) {
  const r = (await query(text, params)).rows;
  if (r.length > 1) throw new Error(`expected at most 1 row, got ${r.length}`);
  return r[0] || null;
}

/** A single scalar from the first column of the first row, or null. */
export async function scalar(text, params) {
  const r = await one(text, params);
  return r ? Object.values(r)[0] : null;
}

export async function close() {
  if (impl) { await impl.close(); impl = null; }
}

export async function driverName() {
  return (await db()).driver;
}
