// Database-level tests. These run against a throwaway PGlite instance, so they
// exercise the real schema — real constraints, real upsert semantics, real SQL
// — without a server or an account.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'csp-test-'));
process.env.PGLITE_DIR = dir;
delete process.env.DATABASE_URL;          // never let a test touch a real database

const { query, close } = await import('../lib/db.js');
const { migrate } = await import('../scripts/migrate.js');
const { writeFacts, ingest, lastRuns } = await import('../lib/ingest.js');
const { totals, weekDays, coverage, brandSplit, interiorGaps, freshness } = await import('../lib/metrics.js');

let orgId, sourceId;

before(async () => {
  await migrate({ quiet: true });
  orgId = (await query(`insert into org (slug, name) values ('acme', 'Acme') returning id`)).rows[0].id;
  sourceId = (await query(
    `insert into source (org_id, kind, external_id, label, lag_days)
     values ($1, 'gsc', 'sc-domain:acme.test', 'acme.test', 3) returning id`,
    [orgId],
  )).rows[0].id;
});

after(async () => { await close(); rmSync(dir, { recursive: true, force: true }); });

test('facts round-trip through SQL aggregation', async () => {
  await writeFacts(sourceId, [
    { day: '2026-08-10', dim: 'total', clicks: 10, impressions: 100, position_sum: 500 },
    { day: '2026-08-11', dim: 'total', clicks: 20, impressions: 300, position_sum: 900 },
  ]);
  const t = await totals(sourceId, '2026-08-01', '2026-08-31');
  assert.equal(Number(t.clicks), 30);
  assert.equal(Number(t.impressions), 400);
  // Impression-weighted: (500 + 900) / 400 = 3.5. Averaging the two daily
  // averages (5 and 3) would give 4 — the error this storage choice prevents.
  assert.equal(Number(t.position), 3.5);
  assert.equal(Number(t.days), 2);
});

test('re-ingesting the same window does not duplicate rows', async () => {
  const rows = [
    { day: '2026-08-12', dim: 'query', a: 'acme pricing', clicks: 5, impressions: 50, position_sum: 100 },
    { day: '2026-08-12', dim: 'query', a: 'acme login', clicks: 3, impressions: 30, position_sum: 60 },
  ];
  await writeFacts(sourceId, rows);
  await writeFacts(sourceId, rows);
  const n = (await query(
    `select count(*)::int as n from fact_daily where source_id = $1 and dim = 'query'`,
    [sourceId],
  )).rows[0].n;
  assert.equal(n, 2, 'the natural key makes re-runs idempotent');
});

test('a conflicting row is replaced, so corrected figures win', async () => {
  // Late-attributed conversions and restated metrics are normal upstream.
  await writeFacts(sourceId, [
    { day: '2026-08-12', dim: 'query', a: 'acme pricing', clicks: 9, impressions: 90, position_sum: 180 },
  ]);
  const r = (await query(
    `select clicks from fact_daily
      where source_id = $1 and dim = 'query' and a = 'acme pricing' and day = '2026-08-12'`,
    [sourceId],
  )).rows[0];
  assert.equal(Number(r.clicks), 9);
});

test('a failed connector records the failure and writes nothing', async () => {
  const boom = { name: 'boom', fetch: async () => { throw new Error('upstream 503'); } };
  await assert.rejects(() => ingest({ id: sourceId }, boom), /upstream 503/);

  const run = (await query(
    `select status, error from ingest_run where source_id = $1
      order by started_at desc limit 1`, [sourceId],
  )).rows[0];
  assert.equal(run.status, 'error');
  assert.match(run.error, /upstream 503/);
});

test('a partial write rolls back rather than leaving half a source loaded', async () => {
  const before = (await query(
    `select count(*)::int as n from fact_daily where source_id = $1`, [sourceId],
  )).rows[0].n;

  // dim is NOT NULL; the second batch violates it. The first must not survive.
  await assert.rejects(() => writeFacts(sourceId, [
    { day: '2026-09-01', dim: 'total', clicks: 1 },
    { day: '2026-09-02', dim: null, clicks: 1 },
  ]));

  const after = (await query(
    `select count(*)::int as n from fact_daily where source_id = $1`, [sourceId],
  )).rows[0].n;
  assert.equal(after, before, 'the whole write is one transaction');
});

test('week bucketing in SQL is Monday-based, matching lib/weeks.js', async () => {
  const weeks = await weekDays(sourceId);
  // 2026-08-10 is a Monday; 2026-08-11 falls in the same week.
  const w = weeks.find((r) => r.week === '2026-08-10');
  assert.ok(w, 'expected a week starting 2026-08-10');
  assert.equal(Number(w.days), 2);
});

test('coverage measures the two ratios rather than assuming them', async () => {
  const cov = await coverage(sourceId, '2026-08-01', '2026-08-31');
  assert.equal(Number(cov.total_clicks), 30);
  assert.equal(Number(cov.query_clicks), 12); // 9 + 3, after the correction above
  assert.ok(Number(cov.query_clicks) < Number(cov.total_clicks));
});

test('brand classification in SQL treats terms as literals', async () => {
  await query(`insert into brand_term (org_id, term) values ($1, 'acme')`, [orgId]);
  const split = await brandSplit(sourceId, ['acme'], '2026-08-01', '2026-08-31');
  assert.equal(split.brand.clicks, 12);
  assert.equal(split.nonbrand.clicks, 0);

  // A term containing a LIKE metacharacter must match itself, not act as a
  // wildcard — the SQL-side counterpart of the regex-escaping rule.
  const wild = await brandSplit(sourceId, ['%'], '2026-08-01', '2026-08-31');
  assert.equal(wild.brand.clicks, 0, "'%' must not match every query");
});

test('freshness is measured from the facts, not declared', async () => {
  const f = await freshness(sourceId, 'total');
  assert.equal(f.through, '2026-08-11');
  assert.ok(Number(f.observed_lag) > 0);
});

test('interior gaps exclude the first and last weeks', async () => {
  // Three weeks, with the middle one short. Only the middle may be reported.
  const s2 = (await query(
    `insert into source (org_id, kind, external_id, label)
     values ($1, 'gsc', 'sc-domain:gap.test', 'gap.test') returning id`, [orgId],
  )).rows[0].id;
  const mk = (d) => ({ day: d, dim: 'total', clicks: 1, impressions: 1, position_sum: 1 });
  await writeFacts(s2, [
    ...['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-06', '2026-06-07'].map(mk),
    ...['2026-06-08', '2026-06-09'].map(mk),                       // short middle week
    ...['2026-06-15', '2026-06-16', '2026-06-17', '2026-06-18', '2026-06-19', '2026-06-20', '2026-06-21'].map(mk),
  ]);
  const gaps = await interiorGaps(s2, 'total');
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].week, '2026-06-08');
  assert.equal(Number(gaps[0].days), 2);
});

test('ingest health is queryable per source', async () => {
  const runs = await lastRuns(orgId);
  assert.ok(runs.length >= 1);
  assert.ok(runs.every((r) => 'status' in r && 'started_at' in r));
});

/* Regression: snapshot dimensions must replace, not accumulate.
 *
 * A snapshot tab has no date of its own, so it is stamped with the day it was
 * read. Upserting one appends a near-identical copy every run — 17k rows a day
 * for one GA4 landing-page tab, which is unbounded growth for no information.
 * Worse, the resulting series invites reading it as a daily trend when each
 * point actually covers a trailing 90-day window. */
test('snapshot dimensions are replaced on each run, not appended', async () => {
  const s3 = (await query(
    `insert into source (org_id, kind, external_id, label)
     values ($1, 'ga4', 'snap.test', 'snap.test') returning id`, [orgId],
  )).rows[0].id;

  const snapshot = (day) => [
    { day, dim: 'landing_snapshot', a: '/pricing', b: 'Organic Search', sessions: 10 },
    { day, dim: 'landing_snapshot', a: '/about', b: 'Direct', sessions: 4 },
  ];
  const opts = { replaceDims: ['landing_snapshot'] };

  await writeFacts(s3, snapshot('2026-09-01'), opts);
  await writeFacts(s3, snapshot('2026-09-02'), opts);   // read again the next day
  await writeFacts(s3, snapshot('2026-09-03'), opts);

  const r = (await query(
    `select count(*)::int as rows, count(distinct day)::int as days,
            to_char(max(day), 'YYYY-MM-DD') as day
       from fact_daily where source_id = $1 and dim = 'landing_snapshot'`,
    [s3],
  )).rows[0];

  assert.equal(r.days, 1, 'only the newest snapshot is retained');
  assert.equal(r.rows, 2);
  assert.equal(r.day, '2026-09-03');
});

test('replacing one dimension leaves the others untouched', async () => {
  const s4 = (await query(
    `insert into source (org_id, kind, external_id, label)
     values ($1, 'ga4', 'mixed.test', 'mixed.test') returning id`, [orgId],
  )).rows[0].id;

  // A dated series alongside a snapshot: the daily rows must accumulate as
  // normal even while the snapshot beside them is being wholly replaced.
  await writeFacts(s4, [
    { day: '2026-09-01', dim: 'channel', a: 'Organic Search', sessions: 5 },
    { day: '2026-09-01', dim: 'landing_snapshot', a: '/x', sessions: 1 },
  ], { replaceDims: ['landing_snapshot'] });
  await writeFacts(s4, [
    { day: '2026-09-02', dim: 'channel', a: 'Organic Search', sessions: 7 },
    { day: '2026-09-02', dim: 'landing_snapshot', a: '/x', sessions: 2 },
  ], { replaceDims: ['landing_snapshot'] });

  const daily = (await query(
    `select count(*)::int as n from fact_daily where source_id = $1 and dim = 'channel'`,
    [s4],
  )).rows[0].n;
  const snap = (await query(
    `select count(*)::int as n from fact_daily where source_id = $1 and dim = 'landing_snapshot'`,
    [s4],
  )).rows[0].n;

  assert.equal(daily, 2, 'dated rows still accumulate');
  assert.equal(snap, 1, 'the snapshot was replaced');
});

test('health reports a source that has never ingested as unknown', async () => {
  const { health } = await import('../lib/health.js');
  const s5 = (await query(
    `insert into source (org_id, kind, external_id, label)
     values ($1, 'hubspot', 'never.test', 'never.test') returning id`, [orgId],
  )).rows[0].id;

  const h = await health('acme');
  const row = h.sources.find((x) => x.id === Number(s5));
  assert.equal(row.status, 'unknown');
  assert.match(row.reason, /never ingested/);
  // One unresolved source must degrade the rollup — a platform with a broken
  // source is not "mostly fine", somebody is reading a panel that is wrong.
  assert.notEqual(h.status, 'ok');
});
