import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weekOf, addDays, daysBetween, toDay, completeness } from '../lib/weeks.js';

test('weeks start on Monday', () => {
  assert.equal(weekOf('2026-08-26'), '2026-08-24'); // Wednesday -> Monday
  assert.equal(weekOf('2026-08-24'), '2026-08-24'); // Monday -> itself
  assert.equal(weekOf('2026-08-23'), '2026-08-17'); // Sunday -> previous Monday
});

test('week bucketing is stable across a year boundary', () => {
  assert.equal(weekOf('2027-01-01'), '2026-12-28');
});

test('date arithmetic', () => {
  assert.equal(addDays('2026-08-26', 7), '2026-09-02');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(daysBetween('2026-08-01', '2026-08-26'), 25);
});

test('toDay handles every shape a source hands back', () => {
  assert.equal(toDay('2026-08-26'), '2026-08-26');
  assert.equal(toDay('2026-08-26 00:00:00'), '2026-08-26');
  assert.equal(toDay(new Date('2026-08-26T12:00:00Z')), '2026-08-26');
  assert.equal(toDay(''), '');
  assert.equal(toDay(null), '');
});

test('toDay parses US-formatted dates rather than truncating them', () => {
  // A date-formatted spreadsheet column exports as M/D/YYYY. Slicing that to
  // ten characters yields "4/29/2025 " — which sorts wrongly and buckets into
  // the wrong week.
  assert.equal(toDay('4/29/2025'), '2025-04-29');
  assert.equal(toDay('12/3/2025'), '2025-12-03');
});

test('a week needs seven days to be complete', () => {
  const c = completeness({ '2026-08-10': 7, '2026-08-17': 7, '2026-08-24': 4 });
  assert.deepEqual(c.complete, [true, true, false]);
  assert.equal(c.weeks[c.lastComplete], '2026-08-17');
});

/* The bug this guards. Search Console lags ~3 days, so the newest week always
 * holds 4-5 days. A previous build charted it beside full weeks and read the
 * shortfall as a decline, turning a real -20% into a reported -24%. */
test('regression: the newest partial week is never the last complete one', () => {
  const c = completeness({ '2026-08-10': 7, '2026-08-17': 7, '2026-08-24': 4 });
  assert.notEqual(c.lastComplete, c.weeks.length - 1);
  assert.equal(c.weeks[c.lastComplete], '2026-08-17');
});

test('all-partial history reports no complete week rather than guessing', () => {
  const c = completeness({ '2026-08-24': 3 });
  assert.equal(c.lastComplete, -1);
});
