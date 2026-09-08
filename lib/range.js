// Range resolution — which weeks a view is allowed to report on.
//
// Every panel in the old build took a date range on trust and charted whatever
// fell inside it. That is how a four-day week ended up beside seven-day weeks
// and turned a real -20% into a reported -24%. The range itself has to be the
// thing that knows better, because a rule enforced in one place cannot be
// forgotten by the next panel someone adds.
//
// Three decisions live here, and all three are refusals:
//
//   A default range never ends inside an incomplete week. It ends on the last
//   week that holds all seven days, even though that discards the most recent
//   few days of real data. Recency is worth less than comparability.
//
//   An explicitly requested range MAY end inside an incomplete week, because
//   sometimes you do want to see today. It comes back with a caveat attached
//   and the affected weeks named, so the renderer can draw them differently.
//
//   A comparison window that does not fit inside the available history is not
//   computed. Comparing thirteen weeks against the eight that happen to exist
//   would overstate the change; returning no prior window and saying so is the
//   honest answer.

import { weekDays } from './metrics.js';
import { addDays, weekOf } from './weeks.js';
import { partialWeek, noPriorWindow } from './provenance.js';

const WEEK = 7;

/** Parse "13w" / "26w" / "52w" / "4w" into a week count. */
export function parseWindow(spec, fallback = 13) {
  const m = /^(\d{1,3})w$/.exec(String(spec || '').trim());
  if (!m) return fallback;
  return Math.min(Math.max(Number(m[1]), 1), 520);
}

/**
 * Resolve a range for one source.
 *
 * @param sourceId
 * @param opts.weeks   how many weeks to cover (default 13)
 * @param opts.from    explicit start (YYYY-MM-DD), overrides `weeks`
 * @param opts.to      explicit end (YYYY-MM-DD), overrides the completeness default
 * @param opts.compare whether to resolve a prior window (default true)
 */
export async function resolveRange(sourceId, opts = {}) {
  const rows = await weekDays(sourceId);
  if (!rows.length) {
    return { empty: true, from: null, to: null, weeks: [], prior: null, caveats: [] };
  }

  const keys = rows.map((r) => r.week);
  const days = rows.map((r) => Number(r.days));
  const dayOf = new Map(keys.map((k, i) => [k, days[i]]));

  const earliestWeek = keys[0];
  const latestWeek = keys[keys.length - 1];

  // The newest week holding all seven days. Everything defaults to ending here.
  let lastComplete = -1;
  for (let i = keys.length - 1; i >= 0; i--) if (days[i] >= WEEK) { lastComplete = i; break; }

  const caveats = [];
  const explicitEnd = Boolean(opts.to);

  // --- end of range ---
  let endWeek;
  if (opts.to) {
    endWeek = weekOf(opts.to);
    if (endWeek > latestWeek) endWeek = latestWeek;
    if (endWeek < earliestWeek) endWeek = earliestWeek;
  } else if (lastComplete >= 0) {
    endWeek = keys[lastComplete];
  } else {
    // No complete week exists anywhere — a brand-new property. Report on what
    // there is, and say plainly that none of it is a full week.
    endWeek = latestWeek;
  }

  // --- start of range ---
  const nWeeks = opts.from ? null : Math.max(1, Number(opts.weeks) || 13);
  let startWeek;
  if (opts.from) {
    startWeek = weekOf(opts.from);
    if (startWeek < earliestWeek) startWeek = earliestWeek;
    if (startWeek > endWeek) startWeek = endWeek;
  } else {
    const endIdx = keys.indexOf(endWeek);
    const startIdx = Math.max(0, endIdx - (nWeeks - 1));
    startWeek = keys[startIdx];
  }

  const inRange = keys.filter((k) => k >= startWeek && k <= endWeek);
  const from = startWeek;
  const to = addDays(endWeek, WEEK - 1);

  // A default range cannot contain an incomplete week other than the very
  // first week of history. An explicit one can, and is told so.
  const incomplete = inRange.filter((k) => (dayOf.get(k) || 0) < WEEK);
  if (incomplete.length) {
    const pw = partialWeek(incomplete, incomplete.map((k) => dayOf.get(k) || 0));
    if (pw) {
      // Downgrade to informational when the only short week is where the
      // record begins — that is history starting, not data missing.
      const onlyFirst = incomplete.length === 1 && incomplete[0] === earliestWeek;
      caveats.push(onlyFirst ? { ...pw, severity: 'info' } : pw);
    }
  }

  // --- prior window, same number of weeks immediately before ---
  let prior = null;
  if (opts.compare !== false) {
    const startIdx = keys.indexOf(startWeek);
    const span = inRange.length;
    if (startIdx - span >= 0) {
      const pStart = keys[startIdx - span];
      const pEndWeek = keys[startIdx - 1];
      prior = { from: pStart, to: addDays(pEndWeek, WEEK - 1), weeks: span };
    } else {
      caveats.push(noPriorWindow(from, earliestWeek));
    }
  }

  return {
    from, to,
    weeks: inRange,
    weekDays: inRange.map((k) => dayOf.get(k) || 0),
    prior,
    endsInPartialWeek: (dayOf.get(endWeek) || 0) < WEEK,
    explicitEnd,
    available: { firstWeek: earliestWeek, lastWeek: latestWeek,
                 lastCompleteWeek: lastComplete >= 0 ? keys[lastComplete] : null },
    caveats,
  };
}
