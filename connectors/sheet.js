// Legacy transport: read facts out of a Google Sheet an external pipeline fills.
//
// This is the migration path, not the destination. COVU's existing Apps Script
// and Google Ads Script write Search Console, GA4 and paid data into a
// spreadsheet; this connector reads that spreadsheet into Postgres so the
// platform starts with real history on day one instead of an empty database
// waiting three months to become useful.
//
// It is written as a general connector rather than a one-off import because
// spreadsheet-fed sources are a permanent category, not a COVU quirk: plenty
// of teams have a script filling a sheet and no appetite for API credentials.
// Such a source is `transport = 'sheet'` and is otherwise indistinguishable
// from an API-fed one downstream.
//
// Nothing here is hardcoded to a sheet, a tab or a company. The sheet id, the
// gid of every tab and the shape of each tab all come from source.config.

import { parseCSV, objectify, num, int } from '../lib/csv.js';
import { toDay } from '../lib/weeks.js';

/**
 * How to turn one spreadsheet row into fact metric columns.
 *
 * `position` is stored multiplied by impressions. An average position cannot
 * be re-aggregated over a date range, but an impression-weighted sum can, so
 * the weighting is applied on the way in and divided out at read time.
 *
 * Money becomes integer cents and conversions integer hundredths, because
 * accumulating floats across a quarter of daily rows produces visible drift.
 */
const PROFILES = {
  search: (r) => {
    const impressions = int(r.impressions);
    return { clicks: int(r.clicks), impressions, position_sum: num(r.position) * impressions };
  },
  analytics: (r) => ({
    sessions: int(r.sessions),
    engaged_sessions: int(r.engagedSessions ?? r.engaged_sessions),
    users: int(r.totalUsers ?? r.users),
  }),
  events: (r) => ({ events: int(r.count ?? r.events) }),
  paid: (r) => ({
    impressions: int(r.impressions),
    clicks: int(r.clicks),
    cost_cents: Math.round(num(r.cost ?? r.spend) * 100),
    conversions_x100: Math.round(num(r.conversions ?? r.leads) * 100),
    conversion_value_cents: Math.round(num(r.conversion_value ?? 0) * 100),
  }),
  engagement: (r) => ({
    views: int(r.rawViews ?? r.views),
    submissions: int(r.submissions ?? r.formSubmissions),
    contacts: int(r.contacts ?? r.newContacts),
  }),
};

async function fetchTab(sheetId, gid) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
  const res = await fetch(url, { headers: { 'user-agent': 'covu-search-platform' } });
  if (!res.ok) throw new Error(`sheet tab gid=${gid}: HTTP ${res.status}`);
  const text = await res.text();
  // An export that comes back as HTML is a sign-in page, not data.
  if (text.startsWith('<')) {
    throw new Error(`sheet tab gid=${gid}: got HTML, not CSV — sheet is not link-readable`);
  }
  return objectify(parseCSV(text));
}

export function sheetConnector() {
  const notes = { tabs: {}, skipped: [] };
  const snapshotDims = new Set();

  return {
    name: 'sheet',
    notes: () => notes,

    /* Undated tabs are re-stated in full every run and must replace what is
     * there, not accumulate beside it. Populated during fetch(). */
    replaceDims: () => [...snapshotDims],

    /**
     * config: {
     *   sheetId: "…",
     *   tabs: {
     *     daily_totals: { gid: "…", dim: "total",  profile: "search" },
     *     queries:      { gid: "…", dim: "query",  profile: "search", a: "query" },
     *     query_page:   { gid: "…", dim: "query_page", profile: "search", a: "query", b: "page" },
     *     ga_landing:   { gid: "…", dim: "landing_snapshot", profile: "analytics",
     *                     a: "landing", b: "channel", undated: true }
     *   }
     * }
     */
    async fetch(source, window = {}) {
      const { sheetId, tabs } = source.config || {};
      if (!sheetId) throw new Error(`source ${source.id}: config.sheetId is required`);
      if (!tabs || !Object.keys(tabs).length) throw new Error(`source ${source.id}: config.tabs is empty`);

      const facts = [];
      // A snapshot tab has no date column. It is stamped with the newest day
      // seen in the dated tabs, and given a dim ending in _snapshot so that
      // nothing downstream can mistake it for a daily series.
      let newestDay = '';

      const names = Object.keys(tabs);
      const loaded = await Promise.all(names.map(async (name) => {
        try {
          return [name, await fetchTab(sheetId, tabs[name].gid)];
        } catch (err) {
          // One missing tab must not fail an entire ingest. A source that is
          // partly readable is more useful than none, and the skip is recorded
          // rather than swallowed.
          notes.skipped.push({ tab: name, reason: err.message });
          return [name, null];
        }
      }));

      for (const [name, rowsIn] of loaded) {
        if (!rowsIn) continue;
        const spec = tabs[name];
        if (spec.undated) { snapshotDims.add(spec.dim); continue; }
        for (const r of rowsIn) {
          const d = toDay(r.date);
          if (d > newestDay) newestDay = d;
        }
      }

      for (const [name, rowsIn] of loaded) {
        if (!rowsIn) continue;
        const spec = tabs[name];
        const profile = PROFILES[spec.profile];
        if (!profile) throw new Error(`tab ${name}: unknown profile ${spec.profile}`);

        let kept = 0;
        for (const r of rowsIn) {
          const day = spec.undated ? newestDay : toDay(r.date);
          if (!day) continue;
          if (window.since && day < window.since) continue;
          if (window.until && day > window.until) continue;

          const a = spec.a ? String(r[spec.a] ?? '').trim() : '';
          const b = spec.b ? String(r[spec.b] ?? '').trim() : '';
          // A keyed dimension with no key is an empty row, not a total.
          if (spec.a && !a) continue;

          facts.push({ day, dim: spec.dim, a, b, ...profile(r) });
          kept++;
        }
        notes.tabs[name] = { read: rowsIn.length, kept };
      }

      notes.newestDay = newestDay;
      return facts;
    },
  };
}
