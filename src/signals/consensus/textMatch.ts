/**
 * Shared fuzzy-matching helpers for consensus adapters: word-overlap scoring,
 * date proximity, and numeric-condition extraction/comparison. Deliberately
 * simple (Jaccard over significant words, not embeddings) — good enough to
 * gate "is this external market actually about the same question", not a
 * general NLP tool. Every adapter treats a low/ambiguous score as "no match",
 * never as a best-effort guess.
 */

const STOPWORDS = new Set([
  "will", "the", "a", "an", "be", "is", "was", "were", "are", "to", "of", "in", "on", "at",
  "by", "for", "and", "or", "than", "that", "this", "its", "it", "as", "with", "from", "but",
  "does", "did", "do", "has", "have", "had", "more", "less", "between",
]);

function significantWords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return new Set(words);
}

const SENTENCE_STARTERS = new Set(["will", "was", "did", "the", "is", "does"]);

/**
 * Builds a short keyword-only search query for external search APIs. Verified
 * against Polymarket's public-search live: it is sensitive in ways that
 * aren't obviously TF-IDF — passing the full question (including numbers
 * like "180-199") degrades ranking, and even a longer all-lowercase keyword
 * list (6 words, including generic nouns like "post"/"times") returned a
 * completely unrelated, year-old set of events, while a short 4-word query
 * of the SAME topic's proper nouns ("Trump Truth Social posts") returned the
 * exactly correct current events. So this prefers proper nouns (capitalized
 * words, excluding the sentence-initial "Will"/"Was"/etc.) and caps the
 * query at 4 words; it only falls back to generic lowercase keywords if the
 * question has too few proper nouns to work with. Numbers are handled
 * separately via extractNumericCondition for scoring, not via the query.
 */
export function buildSearchQuery(text: string, maxWords = 4): string {
  const rawWords = text.replace(/[^\p{L}\s]/gu, " ").split(/\s+/).filter(Boolean);

  const properNouns = rawWords.filter((w, i) => {
    if (w.length < 3) return false;
    if (/^[A-Z]/.test(w) === false) return false;
    if (i === 0 && SENTENCE_STARTERS.has(w.toLowerCase())) return false;
    return true;
  });

  const seen = new Set<string>();
  const dedupedProperNouns = properNouns.filter((w) => (seen.has(w) ? false : (seen.add(w), true)));

  if (dedupedProperNouns.length >= 3) {
    return dedupedProperNouns.slice(0, maxWords).join(" ");
  }

  const genericWords = rawWords
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  const seenGeneric = new Set<string>();
  const deduped = genericWords.filter((w) => (seenGeneric.has(w) ? false : (seenGeneric.add(w), true)));
  return deduped.slice(0, maxWords).join(" ");
}

/** Jaccard similarity over significant words, 0-1. */
export function wordOverlapScore(a: string, b: string): number {
  const setA = significantWords(a);
  const setB = significantWords(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** 1.0 at 0 days apart, decaying linearly to 0 at maxDays apart. */
export function dateProximityScore(a: Date, b: Date, maxDays = 5): number {
  const diffDays = Math.abs(a.getTime() - b.getTime()) / 86_400_000;
  return Math.max(0, 1 - diffDays / maxDays);
}

export type NumericCondition =
  | { type: "range"; low: number; high: number }
  | { type: "gte"; value: number }
  | { type: "lte"; value: number }
  | { type: "gt"; value: number }
  | { type: "lt"; value: number };

const NUM = "[\\d,]+(?:\\.\\d+)?";

function toNumber(s: string): number {
  return Number(s.replace(/,/g, ""));
}

/**
 * Extracts a single numeric threshold/range condition from free text, e.g.
 * "180-199 times" -> range, "210,000 or more" -> gte, "200+" -> gte,
 * "above 82°F" -> gt, "≥39.0°C" -> gte. Returns null if none/ambiguous —
 * callers must treat null as "no numeric condition available", not as zero.
 */
export function extractNumericCondition(text: string): NumericCondition | null {
  const rangeMatch = text.match(new RegExp(`(${NUM})\\s*[-–—]\\s*(${NUM})`));
  if (rangeMatch) {
    return { type: "range", low: toNumber(rangeMatch[1]!), high: toNumber(rangeMatch[2]!) };
  }

  const plusMatch = text.match(new RegExp(`(${NUM})\\s*\\+`));
  if (plusMatch) {
    return { type: "gte", value: toNumber(plusMatch[1]!) };
  }

  const gteMatch = text.match(new RegExp(`(?:≥|>=|at least)\\s*\\$?\\s*(${NUM})|(${NUM})\\s*or more`, "i"));
  if (gteMatch) {
    return { type: "gte", value: toNumber(gteMatch[1] ?? gteMatch[2]!) };
  }

  const lteMatch = text.match(new RegExp(`(?:≤|<=|at most)\\s*\\$?\\s*(${NUM})|(${NUM})\\s*or less`, "i"));
  if (lteMatch) {
    return { type: "lte", value: toNumber(lteMatch[1] ?? lteMatch[2]!) };
  }

  const gtMatch = text.match(new RegExp(`(?:above|over|greater than|>)\\s*\\$?\\s*(${NUM})`, "i"));
  if (gtMatch) {
    return { type: "gt", value: toNumber(gtMatch[1]!) };
  }

  const ltMatch = text.match(new RegExp(`(?:below|under|less than|<)\\s*\\$?\\s*(${NUM})`, "i"));
  if (ltMatch) {
    return { type: "lt", value: toNumber(ltMatch[1]!) };
  }

  return null;
}

/**
 * Compares two extracted numeric conditions for structural agreement.
 * Returns true (agree), false (disagree — treat as a hard mismatch, this is
 * likely the wrong sibling bucket in a range-bucketed market), or null (not
 * comparable — at least one side had no numeric condition).
 */
export function numericConditionsAgree(a: NumericCondition | null, b: NumericCondition | null): boolean | null {
  if (!a || !b) return null;
  if (a.type !== b.type) return false;
  const tolerance = 0.5;
  switch (a.type) {
    case "range":
      return Math.abs(a.low - (b as typeof a).low) <= tolerance && Math.abs(a.high - (b as typeof a).high) <= tolerance;
    default:
      return Math.abs(a.value - (b as { value: number }).value) <= tolerance;
  }
}
