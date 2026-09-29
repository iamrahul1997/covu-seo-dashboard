// Read-side aggregation. All of it in SQL, none of it in the browser.
//
// The system this replaces shipped every row of every dimension to the client
// in one ~1.3MB payload and aggregated on each render. That is elegant at one
// property and 47k rows, and it stops being viable the moment there are two
// customers or two years of ad-level data. Here the database does the work and
// each view asks only for what it draws.
//
// Two invariants this module is built around:
//
//   Average position is stored impression-weighted (position_sum) and divided
//   out at read time. Averaging pre-averaged positions across days or weeks is
//   simply wrong, and wrong in a direction nobody notices.
//
//   Coverage is measured, never assumed. Query rows undercount and page rows
//   overcount against the same site totals; both ratios are computed from the
//   data so the caveats attached to a response state real numbers.

import { query } from './db.js';

/** Every source for an org, with its most recent ingest outcome attached. */
export async function sourcesFor(orgSlug) {
  const res = await query(
    `select s.*,
            r.status      as last_ingest_status,
            r.finished_at as last_ingest_at,
            r.rows_written as last_ingest_rows,
            r.error        as last_ingest_error
       from source s
       join org o on o.id = s.org_id
       left join lateral (
         select status, finished_at, rows_written, error
           from ingest_run
          where source_id = s.id and finished_at is not null
          order by started_at desc limit 1
       ) r on true
      where o.slug = $1 and s.enabled
      order by s.id`,
    [orgSlug],
  );
  return res.rows;
}

export async function brandTerms(orgSlug) {
  const res = await query(
    `select t.term from brand_term t join org o on o.id = t.org_id
      where o.slug = $1 order by t.term`,
    [orgSlug],
  );
  return res.rows.map((r) => r.term);
}

/**
 * Days present per week for a source, from its ungrouped daily rows.
 *
 * This is the completeness signal. It is derived from the facts themselves
 * rather than declared anywhere, so a week that is short because ingestion
 * failed is reported exactly like a week that is short because the source
 * runs behind — both are, correctly, "not comparable to a full week".
 */
export async function weekDays(sourceId) {
  const res = await query(
    `select to_char(date_trunc('week', day), 'YYYY-MM-DD') as week,
            count(distinct day)::int as days
       from fact_daily
      where source_id = $1 and dim = 'total'
      group by 1 order by 1`,
    [sourceId],
  );
  // date_trunc('week') is Monday-based in Postgres, matching lib/weeks.js.
  return res.rows;
}

/** First and last day held for a source. */
export async function span(sourceId, dim = 'total') {
  const res = await query(
    `select to_char(min(day), 'YYYY-MM-DD') as first,
            to_char(max(day), 'YYYY-MM-DD') as last,
            count(*)::int as rows
       from fact_daily where source_id = $1 and dim = $2`,
    [sourceId, dim],
  );
  return res.rows[0];
}

/** Ungrouped totals over a date range. */
export async function totals(sourceId, from, to) {
  const res = await query(
    `select coalesce(sum(clicks), 0)::bigint      as clicks,
            coalesce(sum(impressions), 0)::bigint as impressions,
            case when sum(impressions) > 0
                 then sum(position_sum) / sum(impressions) end as position,
            count(distinct day)::int              as days
       from fact_daily
      where source_id = $1 and dim = 'total' and day between $2 and $3`,
    [sourceId, from, to],
  );
  return res.rows[0];
}

/** Weekly series of ungrouped totals, with each week's day count alongside. */
export async function weeklyTotals(sourceId, from, to) {
  const res = await query(
    `select to_char(date_trunc('week', day), 'YYYY-MM-DD') as week,
            count(distinct day)::int              as days,
            coalesce(sum(clicks), 0)::bigint      as clicks,
            coalesce(sum(impressions), 0)::bigint as impressions,
            case when sum(impressions) > 0
                 then sum(position_sum) / sum(impressions) end as position
       from fact_daily
      where source_id = $1 and dim = 'total' and day between $2 and $3
      group by 1 order by 1`,
    [sourceId, from, to],
  );
  return res.rows;
}

/** Top values of one dimension over a range. */
export async function topDim(sourceId, dim, from, to, limit = 100) {
  const res = await query(
    `select a as key, b as key2,
            coalesce(sum(clicks), 0)::bigint      as clicks,
            coalesce(sum(impressions), 0)::bigint as impressions,
            case when sum(impressions) > 0
                 then sum(position_sum) / sum(impressions) end as position
       from fact_daily
      where source_id = $1 and dim = $2 and day between $3 and $4
      group by a, b
      order by clicks desc, impressions desc
      limit $5`,
    [sourceId, dim, from, to, limit],
  );
  return res.rows;
}

/**
 * The reconciliation ratios, measured rather than assumed.
 *
 * Query rows land below 100% because Search Console withholds rare queries.
 * Page rows land above it because an impression is counted once per URL shown.
 * Both are reported so the caveats carry the real figures for this range.
 */
export async function coverage(sourceId, from, to) {
  const res = await query(
    `select
       (select coalesce(sum(clicks), 0) from fact_daily
         where source_id = $1 and dim = 'total' and day between $2 and $3)::bigint as total_clicks,
       (select coalesce(sum(impressions), 0) from fact_daily
         where source_id = $1 and dim = 'total' and day between $2 and $3)::bigint as total_impressions,
       (select coalesce(sum(clicks), 0) from fact_daily
         where source_id = $1 and dim = 'query' and day between $2 and $3)::bigint as query_clicks,
       (select coalesce(sum(impressions), 0) from fact_daily
         where source_id = $1 and dim = 'page' and day between $2 and $3)::bigint as page_impressions`,
    [sourceId, from, to],
  );
  return res.rows[0];
}

/**
 * Traffic split by host.
 *
 * A domain property covers every subdomain beneath it. news.covu.com alone
 * takes a double-digit share of impressions at a fraction of the site's
 * click-through rate, and aggregate figures hide that completely.
 */
export async function byHost(sourceId, from, to) {
  const res = await query(
    `select split_part(split_part(a, '://', 2), '/', 1) as host,
            coalesce(sum(clicks), 0)::bigint      as clicks,
            coalesce(sum(impressions), 0)::bigint as impressions
       from fact_daily
      where source_id = $1 and dim = 'page' and day between $2 and $3
      group by 1
      having split_part(split_part(a, '://', 2), '/', 1) <> ''
      order by impressions desc`,
    [sourceId, from, to],
  );
  return res.rows;
}

/** Branded / non-branded split, classified in SQL from literal terms. */
export async function brandSplit(sourceId, terms, from, to) {
  if (!terms || !terms.length) return null;
  // ILIKE with escaped literals: same semantics as lib/brand.js, evaluated
  // where the rows are. % and _ are escaped so a term cannot become a pattern.
  const conds = terms.map((_, i) => `a ilike '%' || $${i + 4} || '%'`).join(' or ');
  const escaped = terms.map((t) => t.replace(/[%_\\]/g, '\\$&'));
  const res = await query(
    `select case when ${conds} then 'brand' else 'nonbrand' end as bucket,
            coalesce(sum(clicks), 0)::bigint      as clicks,
            coalesce(sum(impressions), 0)::bigint as impressions
       from fact_daily
      where source_id = $1 and dim = 'query' and day between $2 and $3
      group by 1`,
    [sourceId, from, to, ...escaped],
  );
  const out = { brand: { clicks: 0, impressions: 0 }, nonbrand: { clicks: 0, impressions: 0 } };
  for (const r of res.rows) {
    out[r.bucket] = { clicks: Number(r.clicks), impressions: Number(r.impressions) };
  }
  return out;
}

/**
 * Freshness measured from the facts, against the lag the source declares.
 *
 * Declared lag is configuration; observed lag is evidence. Reporting both is
 * deliberate — when they disagree, that is itself the signal. A source three
 * days behind its own declared lag is not "a source with a lag", it is a
 * pipeline that has stopped running, and those must not look alike.
 */
export async function freshness(sourceId, dim = 'total') {
  const res = await query(
    `select to_char(max(day), 'YYYY-MM-DD') as through,
            (current_date - max(day))::int  as observed_lag
       from fact_daily where source_id = $1 and dim = $2`,
    [sourceId, dim],
  );
  return res.rows[0];
}

/**
 * Weeks missing days somewhere other than the ends of the history.
 *
 * A short first week is where the record begins; a short last week is the
 * reporting lag. A short week in the middle is neither — it is data that was
 * never loaded, and it silently depresses whatever range contains it.
 */
export async function interiorGaps(sourceId, dim = 'total') {
  const res = await query(
    `with w as (
       select date_trunc('week', day) as week, count(distinct day)::int as days
         from fact_daily where source_id = $1 and dim = $2 group by 1
     )
     select to_char(week, 'YYYY-MM-DD') as week, days from w
      where days < 7
        and week <> (select min(week) from w)
        and week <> (select max(week) from w)
      order by week`,
    [sourceId, dim],
  );
  return res.rows;
}

/** The dimension a source uses as its ungrouped daily series, if it has one. */
export async function primaryDim(sourceId) {
  const res = await query(
    `select dim, count(*)::int as n from fact_daily
      where source_id = $1 and dim not like '%_snapshot'
      group by dim order by (dim = 'total') desc, n desc limit 1`,
    [sourceId],
  );
  return res.rows[0]?.dim || null;
}
