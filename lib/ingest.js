// Ingestion: write facts, and record that we did.
//
// Two guarantees this layer provides so that no connector has to:
//
//   Idempotence. Facts upsert on their natural key, so any connector may be
//   re-run over any window at any time. Late-attributed conversions correct
//   themselves on the next pass, a crashed run is fixed by running it again,
//   and a backfill can overlap a nightly job harmlessly. The current system
//   achieves this by having each script rewrite a trailing 90 days; here it is
//   a property of the write itself.
//
//   Observability. Every run opens a row in ingest_run and closes it with an
//   outcome. A failure is a queryable record with a window and an error, not a
//   line in a log nobody is watching.

import { query, transaction } from './db.js';

export const FACT_COLUMNS = [
  'clicks', 'impressions', 'position_sum',
  'sessions', 'engaged_sessions', 'users', 'events',
  'cost_cents', 'conversions_x100', 'conversion_value_cents',
  'views', 'submissions', 'contacts',
];

const ALL = ['source_id', 'day', 'dim', 'a', 'b', ...FACT_COLUMNS];

// Postgres caps a statement at 65535 bound parameters. 500 rows x 18 columns
// leaves generous headroom while keeping round-trips low.
const BATCH = 500;

/**
 * Upsert fact rows. Each row needs { day, dim } and may carry a, b and any
 * metric column; anything absent is written as null.
 *
 * A conflicting row is REPLACED, not merged. A connector owns its
 * (source, dim) space completely, so merging would let a value deleted
 * upstream survive here forever.
 *
 * The whole write is one transaction: a source is loaded completely or not at
 * all, and the database commits once instead of once per batch.
 *
 * `replaceDims` names dimensions the connector re-states in full on every run,
 * which are cleared before the write. Upserting is the right default — it
 * preserves history the source has aged out — but it is wrong for a snapshot.
 * A snapshot tab has no date of its own and is stamped with the day it was
 * read, so upserting one appends a near-identical copy of itself daily and
 * grows without bound. Worse, a series of snapshots invites reading it as a
 * daily trend when each point actually covers a trailing 90-day window.
 */
export async function writeFacts(sourceId, rows, { replaceDims = [] } = {}) {
  return transaction(async (tx) => {
    for (const dim of replaceDims) {
      await tx.query('delete from fact_daily where source_id = $1 and dim = $2', [sourceId, dim]);
    }
    return writeFactsIn(tx, sourceId, rows);
  });
}

/** The write itself, against an existing transaction handle. */
export async function writeFactsIn(tx, sourceId, rows) {
  let written = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const params = [];
    const tuples = chunk.map((r) => {
      const vals = [
        sourceId,
        r.day,
        r.dim,
        r.a ?? '',
        r.b ?? '',
        ...FACT_COLUMNS.map((c) => (r[c] === undefined ? null : r[c])),
      ];
      const start = params.length;
      params.push(...vals);
      return `(${vals.map((_, j) => `$${start + j + 1}`).join(',')})`;
    });

    await tx.query(
      `insert into fact_daily (${ALL.join(',')}) values ${tuples.join(',')}
       on conflict (source_id, day, dim, a, b) do update set
       ${FACT_COLUMNS.map((c) => `${c} = excluded.${c}`).join(', ')}`,
      params,
    );
    written += chunk.length;
  }

  return written;
}

/** Open an ingest_run row and return its id. */
export async function startRun(sourceId, connector, windowStart, windowEnd) {
  const res = await query(
    `insert into ingest_run (source_id, connector, window_start, window_end)
     values ($1, $2, $3, $4) returning id`,
    [sourceId, connector, windowStart || null, windowEnd || null],
  );
  return res.rows[0].id;
}

export async function finishRun(runId, { status, rows, error, notes }) {
  await query(
    `update ingest_run set finished_at = now(), status = $2, rows_written = $3,
                           error = $4, notes = $5
     where id = $1`,
    [runId, status, rows || 0, error ? String(error).slice(0, 2000) : null,
      JSON.stringify(notes || {})],
  );
}

/**
 * Run one connector against one source, recording the outcome either way.
 *
 * `connector.fetch(source, window)` returns fact rows. Everything else —
 * the run row, the upsert, the error handling — happens here, so a connector
 * is only ever responsible for turning an API response into fact rows.
 */
export async function ingest(source, connector, window = {}) {
  const runId = await startRun(source.id, connector.name, window.since, window.until);
  try {
    const rows = await connector.fetch(source, window);
    const written = await writeFacts(source.id, rows, {
      replaceDims: connector.replaceDims ? connector.replaceDims() : [],
    });
    await finishRun(runId, {
      status: 'ok',
      rows: written,
      notes: connector.notes ? connector.notes() : {},
    });
    return { runId, rows: written, status: 'ok' };
  } catch (err) {
    await finishRun(runId, { status: 'error', rows: 0, error: err?.message || String(err) });
    throw err;
  }
}

/** Most recent run per source, for the provenance envelope and health checks. */
export async function lastRuns(orgId) {
  const res = await query(
    `select distinct on (r.source_id)
            r.source_id, r.connector, r.status, r.started_at, r.finished_at,
            r.rows_written, r.error
       from ingest_run r
       join source s on s.id = r.source_id
      where s.org_id = $1
      order by r.source_id, r.started_at desc`,
    [orgId],
  );
  return res.rows;
}
