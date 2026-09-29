// Reconciliation: prove the database says what the source says.
//
// This is the acceptance test for the migration. It re-reads the spreadsheet
// independently of the connector, recomputes totals from the raw CSV, and
// compares them against what SQL returns from Postgres. If a row was dropped,
// a date mis-parsed, or a metric scaled wrongly on the way in, the numbers
// diverge here rather than in front of someone making a decision.
//
// It then checks the invariants that are genuinely true of this data — and
// only those. An earlier version asserted "the newest week is always
// incomplete", which is false: when a source's lag lands exactly on a week
// boundary, the newest week is complete and nothing is wrong. Asserting a
// convenient story rather than the actual rule is the failure mode this whole
// project exists to avoid, so it is worth naming here.
//
// The comparison is scoped to the window the SOURCE still covers, not to
// everything the database holds. The upstream sheet is a rolling window and
// discards its oldest days as it gains new ones, so Postgres legitimately
// retains history the sheet no longer has. Comparing whole spans would report
// that accumulation as a mismatch, when it is the entire point of the rewrite.
//
// A check that cannot be evaluated is reported as such and never counted as a
// pass. Silence is not evidence.
//
//   node scripts/reconcile.js [orgSlug]

import { query, close } from '../lib/db.js';
import { parseCSV, objectify, int, num } from '../lib/csv.js';
import { toDay, weekOf, completeness } from '../lib/weeks.js';
import {
  sourcesFor, brandTerms, weekDays, span, coverage, byHost, brandSplit,
  freshness, interiorGaps, primaryDim,
} from '../lib/metrics.js';
import { brandMatcher } from '../lib/brand.js';


async function csvTab(sheetId, gid) {
  const res = await fetch(`https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return objectify(parseCSV(await res.text()));
}

/* What each profile contributes, so a tab can be re-totalled from raw CSV the
 * same way the connector totalled it — but by separate code, which is the
 * point of a reconciliation. */
const SUMS = {
  search:    { clicks: (r) => int(r.clicks), impressions: (r) => int(r.impressions) },
  analytics: { sessions: (r) => int(r.sessions) },
  events:    { events: (r) => int(r.count ?? r.events) },
  paid:      { clicks: (r) => int(r.clicks),
               cost_cents: (r) => Math.round(num(r.cost ?? r.spend) * 100) },
};

/**
 * Run every reconciliation check for an org and return the outcome.
 *
 * Exported so the CLI, `scripts/refresh.js` and the scheduled cron route all
 * run the same checks. Verification that only exists in a script someone has
 * to remember to type is verification that stops happening.
 */
export async function reconcile(orgSlug = 'covu', { quiet = false } = {}) {
  const out = [];
  const say = quiet ? () => {} : (...a) => console.log(...a);
  const check = (name, ok, detail) => {
    out.push({ name, ok, detail });
    const mark = ok === true ? '  ok  ' : ok === null ? ' skip ' : ' FAIL ';
    say(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
  };
  const note = (msg) => { out.push({ name: msg, ok: 'note' }); say(`         note: ${msg}`); };

  const sources = await sourcesFor(orgSlug);
  if (!sources.length) throw new Error(`no sources for org "${orgSlug}"`);

  say(`\nReconciling org "${orgSlug}" — ${sources.length} sources\n`);

  for (const s of sources) {
    say(`── #${s.id} ${s.label}`);

    check(`#${s.id} last ingest succeeded`, s.last_ingest_status === 'ok',
      `status=${s.last_ingest_status ?? 'never run'}, rows=${s.last_ingest_rows ?? 0}`);
    if (s.last_ingest_status !== 'ok') { say(''); continue; }

    const tabs = s.config.tabs || {};
    const dim = await primaryDim(s.id);

    // Every source is reconciled against whichever dated tab feeds its primary
    // dimension — dim='total' for Search Console, dim='channel' for GA4,
    // dim='campaign' for Ads. Nothing goes unverified for want of a totals tab.
    const entry = Object.entries(tabs).find(([, t]) => t.dim === dim && !t.undated);

    if (!entry) {
      check(`#${s.id} has a dated tab to reconcile`, null, `primary dim=${dim ?? 'none'}`);
    } else {
      const [tabName, spec] = entry;
      const raw = await csvTab(s.config.sheetId, spec.gid);
      const adders = SUMS[spec.profile];

      const wanted = {};
      const days = new Set();
      for (const k of Object.keys(adders)) wanted[k] = 0;
      for (const r of raw) {
        const d = toDay(r.date);
        if (!d) continue;
        if (spec.a && !String(r[spec.a] ?? '').trim()) continue;  // matches the connector
        days.add(d);
        for (const [k, f] of Object.entries(adders)) wanted[k] += f(r);
      }

      // The sheet's own window. Everything below compares inside it.
      const sorted = [...days].sort();
      const from = sorted[0], to = sorted[sorted.length - 1];

      const cols = Object.keys(adders).map((k) => `coalesce(sum(${k}),0)::bigint as ${k}`).join(', ');
      const got = (await query(
        `select ${cols}, count(distinct day)::int as days
           from fact_daily where source_id = $1 and dim = $2 and day between $3 and $4`,
        [s.id, dim, from, to],
      )).rows[0];

      for (const k of Object.keys(adders)) {
        check(`#${s.id} ${tabName}.${k} matches the sheet`,
          Number(got[k]) === wanted[k], `sheet=${wanted[k]} db=${Number(got[k])} over ${from}..${to}`);
      }
      check(`#${s.id} every day survived the load`,
        Number(got.days) === days.size, `sheet=${days.size} db=${Number(got.days)}`);

      // History the sheet has aged out but Postgres still holds. Not a fault —
      // the reason for having a database at all. Reported so the value is visible.
      const retained = (await query(
        `select count(distinct day)::int as days, to_char(min(day), 'YYYY-MM-DD') as first
           from fact_daily where source_id = $1 and dim = $2 and day < $3`,
        [s.id, dim, from],
      )).rows[0];
      if (Number(retained.days) > 0) {
        note(`${retained.days} day(s) from ${retained.first} retained in Postgres `
          + 'but no longer present in the sheet (rolling window)');
      }

      // The set of days must match exactly, not merely be the same size. A day
      // dropped and a day invented would cancel out in a count.
      const dbDays = new Set((await query(
        `select to_char(day, 'YYYY-MM-DD') as d from fact_daily
          where source_id = $1 and dim = $2 and day between $3 and $4 group by 1`,
        [s.id, dim, from, to],
      )).rows.map((r) => r.d));
      const onlySheet = [...days].filter((d) => !dbDays.has(d));
      const onlyDb = [...dbDays].filter((d) => !days.has(d));
      check(`#${s.id} gaps in the source are reproduced faithfully`,
        onlySheet.length === 0 && onlyDb.length === 0,
        onlySheet.length || onlyDb.length
          ? `missing from db: ${onlySheet.slice(0, 3).join(',')} | not in sheet: ${onlyDb.slice(0, 3).join(',')}`
          : `${dbDays.size} days identical on both sides`);

      // Week bucketing, computed independently in JS and in SQL.
      const perWeek = {};
      for (const d of days) perWeek[weekOf(d)] = (perWeek[weekOf(d)] || 0) + 1;
      const fromCsv = completeness(perWeek);
      const fromDb = (await query(
        `select to_char(date_trunc('week', day), 'YYYY-MM-DD') as week,
                count(distinct day)::int as days
           from fact_daily where source_id = $1 and dim = $2 and day between $3 and $4
           group by 1 order by 1`,
        [s.id, dim, from, to],
      )).rows;
      check(`#${s.id} week bucketing agrees between JS and SQL`,
        JSON.stringify(fromDb.map((r) => r.week)) === JSON.stringify(fromCsv.weeks),
        `${fromDb.length} weeks`);
    }

    // ---- freshness: observation against declaration ----
    if (dim) {
      const f = await freshness(s.id, dim);
      check(`#${s.id} freshness matches its declared ${s.lag_days}-day lag`,
        Number(f.observed_lag) <= s.lag_days + 1,
        `through ${f.through}, observed lag ${f.observed_lag}d`);

      // Interior gaps are reported, not failed.
      //
      // A hole in the middle of the record may be missing data OR a genuinely
      // idle period — a paused ad campaign produces no rows at all. Nothing in
      // the data distinguishes them, so the platform must not pretend to: the
      // gap becomes a caveat a human resolves, never an interpolation.
      //
      // What reconciliation CAN assert is that the gap is faithful — that the
      // database is missing exactly the days the source is missing, and has not
      // invented or dropped any of its own.
      const gaps = await interiorGaps(s.id, dim);
      if (gaps.length) {
        note(`${gaps.length} interior week(s) incomplete — `
          + `${gaps.map((g) => `${g.week}:${g.days}d`).join(', ')} `
          + '(reported as a caveat, not assumed to be an error)');
      }
    }

    // ---- the two ratios that must not reconcile with each other ----
    if (s.kind === 'gsc') {
      // Query and page tabs are rolling windows of their own, so the ratios are
      // measured over the range those tabs actually cover.
      const sp = (await query(
        `select to_char(max(min_d), 'YYYY-MM-DD') as first, to_char(min(max_d), 'YYYY-MM-DD') as last
           from (select min(day) as min_d, max(day) as max_d from fact_daily
                  where source_id = $1 and dim in ('total','query','page') group by dim) x`,
        [s.id],
      )).rows[0];
      const cov = await coverage(s.id, sp.first, sp.last);
      const qPct = Number(cov.total_clicks) ? (Number(cov.query_clicks) / Number(cov.total_clicks)) * 100 : 0;
      const pPct = Number(cov.total_impressions) ? (Number(cov.page_impressions) / Number(cov.total_impressions)) * 100 : 0;

      check(`#${s.id} query rows undercount clicks (privacy withholding)`,
        qPct > 0 && qPct < 100, `${qPct.toFixed(1)}% of total clicks`);
      check(`#${s.id} page rows overcount impressions (per-URL counting)`,
        pPct > 100, `${pPct.toFixed(0)}% of total impressions`);

      const hosts = await byHost(s.id, sp.first, sp.last);
      check(`#${s.id} host split is available`, hosts.length > 0,
        hosts.slice(0, 4).map((h) =>
          `${h.host} ${((Number(h.impressions) / Number(cov.page_impressions)) * 100).toFixed(0)}%`).join(', '));

      const terms = await brandTerms(orgSlug);
      const split = await brandSplit(s.id, terms, sp.first, sp.last);
      if (!split) {
        check(`#${s.id} brand split`, null, 'no brand terms configured');
      } else {
        const tot = split.brand.clicks + split.nonbrand.clicks;
        const brandPct = tot ? (split.brand.clicks / tot) * 100 : 0;
        // A broken matcher reports 0% branded. On a property that ranks for its
        // own name, zero is a bug, not a finding — which is exactly what the
        // previous build shipped.
        check(`#${s.id} branded traffic is non-zero`,
          split.brand.clicks > 0, `${brandPct.toFixed(1)}% of query clicks are branded`);

        // Two code paths classify queries — ILIKE in SQL and a regex in JS. If
        // they ever disagree, two panels reading the same rows disagree too.
        const m = brandMatcher(terms);
        const sample = (await query(
          `select distinct a from fact_daily where source_id = $1 and dim = 'query' limit 500`,
          [s.id],
        )).rows.map((r) => r.a);
        const sqlBrand = (await query(
          `select count(*)::int as n from (
             select distinct a from fact_daily where source_id = $1 and dim = 'query' limit 500
           ) q where ${terms.map((_, i) => `a ilike '%' || $${i + 2} || '%'`).join(' or ')}`,
          [s.id, ...terms],
        )).rows[0].n;
        check(`#${s.id} SQL and JS brand classification agree`,
          sample.filter(m).length === sqlBrand,
          `js=${sample.filter(m).length} sql=${sqlBrand} of ${sample.length} sampled`);
      }
    }
  say('');
  }

  const failed = out.filter((r) => r.ok === false);
  const skipped = out.filter((r) => r.ok === null);
  const notes = out.filter((r) => r.ok === 'note');
  const passed = out.length - failed.length - skipped.length - notes.length;
  say(`${passed} passed, ${failed.length} failed, ${skipped.length} not evaluated`);

  return { checks: out, passed, failed, skipped, notes };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await reconcile(process.argv[2] || 'covu');
  await close();
  process.exit(r.failed.length ? 1 : 0);
}
