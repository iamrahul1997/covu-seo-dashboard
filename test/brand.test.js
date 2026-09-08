import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brandMatcher, escapeLiteral, isQuestion } from '../lib/brand.js';

test('matches the brand term anywhere in the query', () => {
  const m = brandMatcher(['covu']);
  assert.ok(m('covu'));
  assert.ok(m('covu insurance'));
  assert.ok(m('is covu legit'));
  assert.ok(m('COVU'), 'matching is case-insensitive');
  assert.ok(m('covuinsurance'), 'substring, not word-boundary');
  assert.ok(m('www.covu.com'));
});

test('does not match unrelated queries', () => {
  const m = brandMatcher(['covu']);
  assert.equal(m('insurance agency software'), false);
  assert.equal(m('how to sell a book of business'), false);
});

/* The regression test this module exists for. The previous implementation used
 * new RegExp("\bcovu\b") — a string, so \b was a backspace character and the
 * pattern matched nothing. Every query was classified non-branded and the
 * dashboard reported non-branded as 100% of clicks against a true ~2%.
 *
 * Asserting "some real query matches" is what that build would have failed. */
test('regression: a configured brand term classifies real traffic as branded', () => {
  const m = brandMatcher(['covu']);
  const queries = ['covu', 'covu reviews', 'covu insurance', 'agency management system'];
  const branded = queries.filter(m);
  assert.equal(branded.length, 3);
  assert.notEqual(branded.length, 0, 'a matcher that matches nothing is the original bug');
});

test('near-miss spellings stay non-branded', () => {
  // covve is a different company. Absorbing it would inflate branded traffic
  // with a competitor's demand.
  const m = brandMatcher(['covu']);
  assert.equal(m('covve'), false);
  assert.equal(m('covou'), false);
});

test('terms are literals, so metacharacters cannot become patterns', () => {
  assert.equal(escapeLiteral('co.vu'), 'co\\.vu');
  const m = brandMatcher(['co.vu']);
  assert.ok(m('co.vu'));
  assert.equal(m('coXvu'), false, '. must not act as a wildcard');
});

test('multiple terms, deduplicated and trimmed', () => {
  const m = brandMatcher([' Covu ', 'covu', 'co vu', '']);
  assert.deepEqual(m.terms, ['covu', 'co vu']);
  assert.ok(m('co vu'));
});

test('no configured terms returns null, not a match-nothing matcher', () => {
  // The distinction matters: "not configured" must be reportable as a caveat,
  // never rendered as "0% branded".
  assert.equal(brandMatcher([]), null);
  assert.equal(brandMatcher(null), null);
});

test('question detection', () => {
  assert.ok(isQuestion('how do agencies reduce service costs'));
  assert.ok(isQuestion('what is an agency management system'));
  assert.ok(isQuestion('covu vs applied epic'));
  assert.ok(isQuestion('best agency software?'));
  assert.equal(isQuestion('agency management system'), false);
});
