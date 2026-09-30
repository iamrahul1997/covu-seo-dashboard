// The browser's brand matcher, extracted from public/app.js and exercised
// directly. app.js is a classic script rather than a module, so the functions
// are lifted out of the source instead of imported — which also guarantees the
// test runs against the shipping text and not a copy that drifted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function lift(name) {
  const m = src.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
  if (!m) throw new Error(`could not find ${name}() in public/app.js`);
  return m[0];
}
const { escapeLiteral, buildBrand } = new Function(
  `${lift('escapeLiteral')}\n${lift('buildBrand')}\nreturn { escapeLiteral, buildBrand };`,
)();

test('terms are matched, case-insensitively', () => {
  const re = buildBrand(['acme']);
  assert.ok(re.test('acme pricing'));
  assert.ok(re.test('ACME reviews'));
  assert.ok(!re.test('insurance software'));
});

test('several terms all match', () => {
  const re = buildBrand(['acme', 'acme corp', 'acmeco']);
  for (const q of ['acme', 'ACME Corp login', 'acmeco support']) assert.ok(re.test(q), q);
});

test('regression: a term is a literal, not a pattern', () => {
  // The bug this whole design exists to prevent: a term arriving as a string
  // and being compiled as a pattern. "co.vu" must not match "coXvu".
  const re = buildBrand(['co.vu']);
  assert.ok(re.test('co.vu login'));
  assert.ok(!re.test('coXvu login'), '"." was compiled as a wildcard');
});

test('regression: backslash-b in a term does not silently match nothing', () => {
  // new RegExp("\bcovu\b") from a string made \b a backspace and matched
  // nothing, reporting 98% branded traffic as non-branded.
  const re = buildBrand(['\\bcovu\\b']);
  assert.ok(!re.test('covu'), 'escaped term unexpectedly matched');
  assert.ok(re.test('\\bcovu\\b'), 'literal term did not match itself');
});

test('metacharacters cannot break the alternation', () => {
  // A term like ")" would previously produce an invalid or wildly wrong regex.
  assert.doesNotThrow(() => buildBrand([')', '(', '[', '*', '+', '?', '|']));
  const re = buildBrand(['a+b']);
  assert.ok(re.test('a+b'));
  assert.ok(!re.test('aab'));
});

test('no terms yields null rather than a regex that lies', () => {
  // Matching everything or nothing would both produce a confident wrong
  // number. null lets callers report "unknown".
  assert.equal(buildBrand([]), null);
  assert.equal(buildBrand(null), null);
  assert.equal(buildBrand(undefined), null);
});

test('blank and whitespace terms are discarded', () => {
  assert.equal(buildBrand(['', '   ']), null);
});

test('escapeLiteral escapes every metacharacter it claims to', () => {
  for (const c of ['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\']) {
    const re = new RegExp(escapeLiteral(c));
    assert.ok(re.test(c), `${c} did not match itself`);
  }
});
