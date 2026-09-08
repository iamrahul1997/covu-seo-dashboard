// Platform health, derived from the data rather than declared anywhere.
//
// This is the table the handoff asked for: "the health line currently logged
// to Vercel becomes a table you can alert on". A log line cannot be queried,
// cannot be graphed, and nothing can page on it. These figures come from
// ingest_run and from the facts themselves, so they are true whether or not
// anyone was watching when the pipeline ran.

import { query } from './db.js';

/**
 * Per-source health for an org, plus a rolled-up status.
 *
 * `ok`      — loaded recently, and no further behind than its declared lag
 * `stale`   — the source is further behind than its lag explains
 * `failed`  — the last ingest recorded an error
 * `unknown` — connected but never successfully ingested
 */
export async function health(orgSlug = 'covu', { staleAfterHours = 36 } = {}) {
  const rows = (await query(
    `select s.id, s.kind, s.label, s.transport, s.lag_days, s.enabled,
            f.through, f.observed_lag, f.rows,
            r.status as ingest_status, r.finished_at as ingest_at,
            r.rows_written as ingest_rows, r.error as ingest_error
       from source s
       join org o on o.id = s.org_id
       left join lateral (
         select to_char(max(day), 'YYYY-MM-DD') as through,
                (current_date - max(day))::int  as observed_lag,
                count(*)::int                   as rows
           from fact_daily where source_id = s.id
       ) f on true
       left join lateral (
         select status, finished_at, rows_written, error
           from ingest_run where source_id = s.id and finished_at is not null
           order by started_at desc limit 1
       ) r on true
      where o.slug = $1 and s.enabled
      order by s.id`,
    [orgSlug],
  )).rows;

  const sources = rows.map((r) => {
    const ageHours = r.ingest_at ? (Date.now() - new Date(r.ingest_at).getTime()) / 3600000 : null;
    const behind = r.observed_lag != null && Number(r.observed_lag) > Number(r.lag_days) + 1;

    let status = 'ok';
    let reason = null;
    if (!r.ingest_status) { status = 'unknown'; reason = 'never ingested successfully'; }
    else if (r.ingest_status === 'error') { status = 'failed'; reason = r.ingest_error; }
    else if (ageHours != null && ageHours > staleAfterHours) {
      status = 'stale';
      reason = `last ingest ${Math.round(ageHours)}h ago, expected within ${staleAfterHours}h`;
    } else if (behind) {
      status = 'stale';
      reason = `data through ${r.through} is ${r.observed_lag}d old, but the declared lag is ${r.lag_days}d`;
    }

    return {
      id: Number(r.id), kind: r.kind, label: r.label, transport: r.transport,
      declaredLagDays: Number(r.lag_days),
      observedLagDays: r.observed_lag == null ? null : Number(r.observed_lag),
      dataThrough: r.through,
      rows: r.rows == null ? 0 : Number(r.rows),
      lastIngestAt: r.ingest_at,
      lastIngestStatus: r.ingest_status,
      lastIngestRows: r.ingest_rows == null ? null : Number(r.ingest_rows),
      status, reason,
    };
  });

  // The rollup takes the worst case. A platform with one broken source is not
  // "mostly fine" — somebody is reading a panel that is quietly wrong.
  const worst = ['failed', 'unknown', 'stale', 'ok']
    .find((s) => sources.some((x) => x.status === s)) || 'ok';

  return {
    org: orgSlug,
    status: worst,
    checkedAt: new Date().toISOString(),
    sources,
  };
}
