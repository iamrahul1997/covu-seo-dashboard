// Branded-query classification.
//
// This module exists because of a specific, expensive bug. A previous build
// classified queries with:
//
//     new RegExp("\bcovu\b")
//
// Built from a *string*, "\b" is a backspace character (U+0008), not a word
// boundary. The pattern matched nothing. Every query fell through to
// "non-branded" and the dashboard reported non-branded traffic as 100% of
// clicks when the real figure was around 2% — a number that drove decisions.
//
// The lesson generalised: never store or transport a pattern as a string that
// something else will compile. Brand terms are stored as literal substrings
// (brand_term.term) and escaped here before they ever reach a regex. A term
// containing regex metacharacters becomes a literal match, not a pattern, and
// a term cannot silently compile into something that matches nothing.

/** Escape every regex metacharacter so a term matches itself and nothing else. */
export function escapeLiteral(term) {
  return String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile literal terms into a case-insensitive matcher.
 *
 * Terms match anywhere in the query, not on word boundaries: "covuinsurance"
 * and "covu.com" are both brand searches. That is deliberate, and it is why
 * near-miss spellings must not be added as terms — "covve" is a different
 * company, and adding it would silently absorb a competitor's traffic into
 * COVU's branded numbers.
 */
export function brandMatcher(terms) {
  const list = [...new Set(
    (terms || [])
      .map((t) => String(t == null ? '' : t).trim().toLowerCase())
      .filter(Boolean),
  )];

  // No configured terms means no basis for classification. Return null rather
  // than a matcher that says "nothing is branded" — a caller can distinguish
  // "not configured" from "genuinely zero branded traffic", and every panel
  // that reports a brand split needs that distinction to avoid repeating the
  // original bug's headline in a new form.
  if (!list.length) return null;

  const re = new RegExp(list.map(escapeLiteral).join('|'), 'i');
  const matcher = (query) => re.test(String(query == null ? '' : query));
  matcher.terms = list;
  matcher.source = re.source;
  return matcher;
}

/**
 * Question-shaped queries — the closest Search Console proxy for the prompts
 * people type into answer engines. Not a brand concept, but it lives with the
 * other query classification so the rules are read together.
 */
const QUESTION_LEAD = /^(who|what|when|where|why|how|which|can|could|should|would|will|does|do|did|is|are|was|were|am)\b/i;

export function isQuestion(query) {
  const s = String(query == null ? '' : query).trim();
  if (!s) return false;
  return QUESTION_LEAD.test(s) || s.includes('?') || /\bvs\.?\b|\bversus\b/i.test(s);
}
