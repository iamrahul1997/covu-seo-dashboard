// Register the first organisation and its sources.
//
// This is configuration expressed as code so it is reviewable, not a fixture.
// Everything here lands in ordinary rows — an org, four sources, brand terms.
// A second customer is the same script with different values, which is the
// whole point of the schema: nothing about COVU is compiled into the platform.
//
//   node scripts/seed.js
//
// Re-running is safe; every insert is an upsert on a natural key.

import { query, close } from '../lib/db.js';
import { migrate } from './migrate.js';

const SHEET = process.env.SEED_SHEET_ID || '1IuI7NqgsrourIz1BeH44zx_Wp5_xSaGffkxYS1eYXXc';

/* Tab -> fact shape. Confirmed against the live sheet's header rows rather
 * than assumed: query_page, appearance, ga_landing and ga_event_landing have
 * no date column at all. They are rolling snapshots over whatever window the
 * pipeline last wrote, and are marked `undated` so they are stamped with the
 * newest dated day and given a *_snapshot dimension. Treating a snapshot as a
 * daily series would put a quarter's worth of traffic on a single date. */
const SOURCES = [
  {
    kind: 'gsc', transport: 'sheet', external_id: 'sc-domain:covu.com',
    label: 'covu.com (Search Console)', lag_days: 3,
    config: {
      sheetId: SHEET,
      tabs: {
        daily_totals: { gid: '1112366620', dim: 'total', profile: 'search' },
        queries:      { gid: '452894128',  dim: 'query', profile: 'search', a: 'query' },
        pages:        { gid: '95425449',   dim: 'page',  profile: 'search', a: 'page' },
        device:       { gid: '347826056',  dim: 'device', profile: 'search', a: 'device' },
        country:      { gid: '267562045',  dim: 'country', profile: 'search', a: 'country' },
        query_page:   { gid: '928135167',  dim: 'query_page_snapshot', profile: 'search',
                        a: 'query', b: 'page', undated: true },
        appearance:   { gid: '1351785315', dim: 'appearance_snapshot', profile: 'search',
                        a: 'searchAppearance', undated: true },
      },
    },
  },
  {
    kind: 'gsc', transport: 'sheet', external_id: 'sc-domain:blog.covu.com',
    label: 'blog.covu.com (Search Console)', lag_days: 3,
    config: {
      sheetId: SHEET,
      tabs: {
        daily_totals: { gid: '1828167911', dim: 'total', profile: 'search' },
        queries:      { gid: '1880118326', dim: 'query', profile: 'search', a: 'query' },
        pages:        { gid: '127603406',  dim: 'page',  profile: 'search', a: 'page' },
        device:       { gid: '945457552',  dim: 'device', profile: 'search', a: 'device' },
        country:      { gid: '1866580908', dim: 'country', profile: 'search', a: 'country' },
        query_page:   { gid: '1975009971', dim: 'query_page_snapshot', profile: 'search',
                        a: 'query', b: 'page', undated: true },
      },
    },
  },
  {
    kind: 'ga4', transport: 'sheet', external_id: '271671175',
    // Measured, not assumed. GA4 publishes no documented lag for this
    // pipeline, and the loaded data sits two days behind. A guessed value
    // would produce a confidently wrong caveat, which is worse than none.
    label: 'GA4 — covu.com', lag_days: 2,
    config: {
      sheetId: SHEET,
      tabs: {
        ga_daily:         { gid: '1410443220', dim: 'channel', profile: 'analytics', a: 'channel' },
        ga_events:        { gid: '1863466715', dim: 'event',   profile: 'events',    a: 'event' },
        ga_landing:       { gid: '1106334035', dim: 'landing_snapshot', profile: 'analytics',
                            a: 'landing', b: 'channel', undated: true },
        ga_event_landing: { gid: '2051391862', dim: 'event_landing_snapshot', profile: 'events',
                            a: 'landing', b: 'event', undated: true },
      },
    },
  },
  {
    kind: 'google_ads', transport: 'sheet', external_id: '351-420-0735',
    // Ad platforms report same-day. Organic does not. Keeping the lag honest
    // per source is what stops "ads have data for days organic does not" from
    // reading as an organic collapse.
    label: 'Google Ads — 351-420-0735', lag_days: 0,
    config: {
      sheetId: SHEET,
      tabs: {
        ads_google_daily:   { gid: '694389940',  dim: 'campaign', profile: 'paid', a: 'campaign' },
        ads_google_keyword: { gid: '1327370572', dim: 'keyword',  profile: 'paid',
                              a: 'keyword', b: 'match_type' },
      },
    },
  },
];

/* Literal substrings, never a regex. Near-miss spellings (covou, covo, covve)
 * are deliberately absent: covve is a different company, and adding it would
 * quietly book a competitor's demand as COVU's branded traffic. */
const BRAND_TERMS = ['covu', 'co.vu', 'co vu'];

export async function seed({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...a) => console.log(...a);
  await migrate({ quiet });

  const org = (await query(
    `insert into org (slug, name) values ($1, $2)
     on conflict (slug) do update set name = excluded.name
     returning id, slug`,
    ['covu', 'COVU, Inc.'],
  )).rows[0];
  log(`org ${org.slug} (#${org.id})`);

  await query(
    `insert into member (org_id, email, role) values ($1, $2, $3)
     on conflict (org_id, email) do update set role = excluded.role`,
    [org.id, 'rahul.poudel@covu.com', 'owner'],
  );

  for (const term of BRAND_TERMS) {
    await query(
      `insert into brand_term (org_id, term) values ($1, $2) on conflict do nothing`,
      [org.id, term],
    );
  }
  log(`brand terms: ${BRAND_TERMS.join(', ')}`);

  const ids = [];
  for (const s of SOURCES) {
    const row = (await query(
      `insert into source (org_id, kind, transport, external_id, label, config, lag_days)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (org_id, kind, external_id) do update set
         label = excluded.label, config = excluded.config,
         lag_days = excluded.lag_days, transport = excluded.transport
       returning id, kind, label`,
      [org.id, s.kind, s.transport, s.external_id, s.label,
        JSON.stringify(s.config), s.lag_days],
    )).rows[0];
    ids.push(row);
    log(`source #${row.id} ${row.kind} — ${row.label}`);
  }

  return { orgId: org.id, sources: ids };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await seed();
  await close();
}
