// Provenance and caveats — the part that makes this a product rather than
// another chart library.
//
// Every BI tool can draw a line. What none of them do is refuse to state what
// they cannot source. This module turns that discipline from prose written by
// hand into each panel — where it is forgotten the moment a new panel is added
// — into structured data that travels with every API response.
//
// A caveat is not a warning about a bug. It is a true statement about the
// limits of the data, and the renderer is expected to show it. The three that
// matter most here were each discovered the hard way:
//
//   * The newest week is short, because the source reports on a lag.
//   * Query-level rows sum to LESS than site totals, because Search Console
//     withholds rare queries to protect the people who typed them.
//   * Page-level rows sum to MORE than site totals, because one search showing
//     two of your URLs is one impression for the site and one for each page.
//
// The second and third contradict each other, and both are correct. A product
// that shows a single "total" and lets the user discover the mismatch on their
// own loses their trust permanently, and deserves to.

export const SEVERITY = { INFO: 'info', WARN: 'warn' };

function caveat(code, severity, title, detail, evidence) {
  return { code, severity, title, detail, evidence: evidence || {} };
}

/** The newest week in range is still filling. */
export function partialWeek(weekKeys, dayCounts) {
  const partial = weekKeys.filter((w, i) => dayCounts[i] > 0 && dayCounts[i] < 7);
  if (!partial.length) return null;
  return caveat(
    'partial_week', SEVERITY.WARN,
    partial.length === 1 ? 'One week in this range is incomplete'
      : `${partial.length} weeks in this range are incomplete`,
    'These weeks hold fewer than seven days of data. They are drawn hollow and '
    + 'are not comparable to full weeks — a short week looks like a decline '
    + 'even when nothing changed.',
    { weeks: partial, days: partial.map((w) => dayCounts[weekKeys.indexOf(w)]) },
  );
}

/** The source reports on a delay, so recent days are deliberately absent. */
export function sourceLag(sourceLabel, lagDays, dataThrough) {
  if (!lagDays) return null;
  return caveat(
    'source_lag', SEVERITY.INFO,
    `${sourceLabel} runs ${lagDays} day${lagDays === 1 ? '' : 's'} behind`,
    `Data is complete through ${dataThrough}. More recent days are not missing — `
    + 'they have not been published yet, and will fill in.',
    { lagDays, dataThrough },
  );
}

/**
 * Query rows cover only part of the total, because rare queries are withheld.
 * Reported whenever coverage is below 95%, which in practice is always.
 */
export function queryCoverage(queryClicks, totalClicks) {
  if (!totalClicks || queryClicks == null) return null;
  const pct = (queryClicks / totalClicks) * 100;
  if (pct >= 95) return null;
  return caveat(
    'query_coverage', SEVERITY.INFO,
    `Query rows account for ${pct.toFixed(0)}% of clicks`,
    'Search Console withholds queries that too few people searched, to protect '
    + 'their privacy. The remainder is real traffic with no query attached, so '
    + 'query tables will never sum to the site total. This is expected, not a gap.',
    { queryClicks, totalClicks, coveragePct: Math.round(pct * 10) / 10 },
  );
}

/**
 * Page rows exceed the total, because impressions are counted per URL shown.
 * The inverse of queryCoverage, and the pairing is the point.
 */
export function pageDoubleCount(pageImpressions, totalImpressions) {
  if (!totalImpressions || pageImpressions == null) return null;
  const pct = (pageImpressions / totalImpressions) * 100;
  if (pct <= 105) return null;
  return caveat(
    'page_double_count', SEVERITY.INFO,
    `Page rows sum to ${Math.round(pct)}% of site impressions`,
    'When one search shows two of your pages, the site counts one impression '
    + 'and each page counts one. Page totals therefore exceed site totals — the '
    + 'opposite of the query tables, and equally correct.',
    { pageImpressions, totalImpressions, ratioPct: Math.round(pct) },
  );
}

/** A domain property silently spans every subdomain under it. */
export function subdomainSpread(hosts) {
  if (!hosts || hosts.length < 2) return null;
  const top = [...hosts].sort((a, b) => b.impressions - a.impressions);
  const total = top.reduce((n, h) => n + h.impressions, 0) || 1;
  const notable = top.filter((h) => h.impressions / total >= 0.05);
  if (notable.length < 2) return null;
  return caveat(
    'subdomain_spread', SEVERITY.INFO,
    `This property covers ${hosts.length} hosts`,
    'A domain property includes every subdomain. Aggregate figures mix them '
    + 'together, and a high-impression, low-engagement subdomain can hide '
    + 'inside a site-wide average.',
    { hosts: notable.map((h) => ({ host: h.host, sharePct: Math.round((h.impressions / total) * 100) })) },
  );
}

/** There is not enough history to draw the comparison that was asked for. */
export function noPriorWindow(rangeStart, earliestDay) {
  return caveat(
    'no_prior_window', SEVERITY.WARN,
    'No prior period to compare against',
    `Data begins ${earliestDay}, so there is no equivalent earlier window before `
    + `${rangeStart}. Change figures are omitted rather than computed against a `
    + 'shorter period, which would overstate them.',
    { rangeStart, earliestDay },
  );
}

/** Ingestion has not run recently enough for this source to be trusted as current. */
export function staleIngest(sourceLabel, lastRunAt, expectedWithinHours) {
  if (!lastRunAt) {
    return caveat('stale_ingest', SEVERITY.WARN, `${sourceLabel} has never been ingested`,
      'This source is connected but no successful run has been recorded.', {});
  }
  const ageHours = (Date.now() - new Date(lastRunAt).getTime()) / 3600000;
  if (ageHours <= expectedWithinHours) return null;
  return caveat(
    'stale_ingest', SEVERITY.WARN,
    `${sourceLabel} last updated ${Math.round(ageHours)} hours ago`,
    `Ingestion is expected at least every ${expectedWithinHours} hours. These `
    + 'figures may not reflect the most recent complete data.',
    { lastRunAt, ageHours: Math.round(ageHours) },
  );
}

/**
 * The source is further behind than its declared lag explains.
 *
 * Distinct from sourceLag, which is the normal, expected delay. This fires
 * when observation and configuration disagree, which means either the pipeline
 * is failing or the declared lag is wrong. Both need a human; neither should
 * be rendered as a quiet dip in the last few days.
 */
export function behindSchedule(sourceLabel, declaredLag, observedLag, dataThrough) {
  if (observedLag <= declaredLag + 1) return null;
  return caveat(
    'behind_schedule', SEVERITY.WARN,
    `${sourceLabel} is ${observedLag - declaredLag} days further behind than expected`,
    `This source declares a ${declaredLag}-day reporting lag but its newest data is `
    + `${dataThrough}, ${observedLag} days old. Recent figures are incomplete for a `
    + 'reason that is not the normal delay.',
    { declaredLag, observedLag, dataThrough },
  );
}

/**
 * Days are missing from the middle of the history.
 *
 * Unlike a short newest week, this cannot be explained by reporting lag. Any
 * range spanning these weeks is understated.
 */
export function interiorGaps(weeks) {
  if (!weeks || !weeks.length) return null;
  return caveat(
    'interior_gaps', SEVERITY.WARN,
    `${weeks.length} week${weeks.length === 1 ? '' : 's'} in the middle of the record are incomplete`,
    'These weeks are missing days that reporting lag does not explain — the data '
    + 'was never loaded. Any range covering them understates the real figures.',
    { weeks },
  );
}

/** No brand terms configured, so any brand split would be meaningless. */
export function brandUnconfigured() {
  return caveat(
    'brand_unconfigured', SEVERITY.WARN,
    'No brand terms configured',
    'Branded and non-branded cannot be separated until this organisation has '
    + 'brand terms set. Reporting everything as non-branded would repeat a real '
    + 'and costly reporting error, so the split is withheld instead.',
    {},
  );
}

/**
 * Assemble the envelope that wraps every API response.
 *
 * `sources` describes what was read and when. `caveats` are collected from the
 * helpers above; nulls are dropped so callers can pass them unconditionally.
 */
export function envelope({ sources, range, caveats }) {
  const list = (caveats || []).filter(Boolean);
  return {
    sources: (sources || []).map((s) => ({
      kind: s.kind,
      label: s.label,
      transport: s.transport,
      lagDays: s.lag_days ?? s.lagDays ?? 0,
      dataThrough: s.dataThrough || null,
      lastIngestAt: s.lastIngestAt || null,
      lastIngestStatus: s.lastIngestStatus || null,
    })),
    range: range || null,
    caveats: list,
    // A renderer that shows nothing else must still show these.
    mustShow: list.filter((c) => c.severity === SEVERITY.WARN).map((c) => c.code),
    generatedAt: new Date().toISOString(),
  };
}
