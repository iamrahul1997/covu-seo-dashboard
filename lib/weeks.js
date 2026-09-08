// Week bucketing and completeness.
//
// The single most consequential piece of arithmetic in the system. Search
// Console publishes roughly three days behind, so the newest week always holds
// four or five days. A previous build charted that partial week beside full
// ones and read the shortfall as a decline — turning a real -20% into a
// reported -24%, and inventing declines outright in flat weeks.
//
// The fix is not to hide partial weeks. It is to know, for every week, how
// many days of data actually exist, and to carry that fact all the way to the
// renderer so it can draw the difference rather than average it away.

/** Monday-start ISO week key for a YYYY-MM-DD day. */
export function weekOf(day) {
  const d = new Date(String(day).slice(0, 10) + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) throw new Error(`weekOf: not a date: ${day}`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

export function addDays(day, n) {
  const d = new Date(String(day).slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  const ms = new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z');
  return Math.round(ms / 86400000);
}

/**
 * Normalise a date-ish cell to YYYY-MM-DD.
 *
 * Sources hand back at least four shapes: ISO, ISO with a time, a Date, and —
 * when a spreadsheet column is date-formatted — US M/D/YYYY. Slicing the last
 * of those to ten characters yields nonsense that sorts wrongly and buckets
 * into the wrong week, so it is parsed rather than truncated.
 */
export function toDay(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const s = String(value).trim();
  if (!s) return '';
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso ? iso[0] : '';
}

/**
 * Given the distinct days present per week, report which weeks are complete.
 *
 * `counts` is a Map or plain object of weekKey -> number of days present.
 * A week is complete at seven days. The last complete week is the newest one
 * with all seven, and is what every default range should end on.
 */
export function completeness(counts) {
  const entries = counts instanceof Map ? [...counts.entries()] : Object.entries(counts || {});
  const weeks = entries.map(([w]) => w).sort();
  const days = weeks.map((w) => Number(counts instanceof Map ? counts.get(w) : counts[w]) || 0);
  const complete = days.map((n) => n >= 7);

  let lastComplete = -1;
  for (let i = weeks.length - 1; i >= 0; i--) {
    if (complete[i]) { lastComplete = i; break; }
  }

  return { weeks, days, complete, lastComplete };
}
