import type { ParsedResolution } from "./types.js";

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// "August 1, 2026" / "Aug 6, 2026" / "Aug. 6, 2026" — month first
const DATE_MONTH_FIRST = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/;
// "7 Aug 2026" — day first
const DATE_DAY_FIRST = /\b(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})\b/;

interface DateMatch {
  index: number;
  end: number;
  utcDate: Date | null;
}

function findDateMatches(text: string): DateMatch[] {
  const matches: DateMatch[] = [];
  const combined = new RegExp(`(?:${DATE_MONTH_FIRST.source})|(?:${DATE_DAY_FIRST.source})`, "gi");
  let m: RegExpExecArray | null;
  while ((m = combined.exec(text)) !== null) {
    let utcDate: Date | null = null;
    if (m[1] !== undefined) {
      // month-first branch
      const monthKey = m[1]!.slice(0, 3).toLowerCase();
      const day = Number(m[2]);
      const year = Number(m[3]);
      const monthIdx = MONTHS[monthKey];
      if (monthIdx !== undefined) utcDate = new Date(Date.UTC(year, monthIdx, day));
    } else if (m[4] !== undefined) {
      // day-first branch
      const day = Number(m[4]);
      const monthKey = m[5]!.slice(0, 3).toLowerCase();
      const year = Number(m[6]);
      const monthIdx = MONTHS[monthKey];
      if (monthIdx !== undefined) utcDate = new Date(Date.UTC(year, monthIdx, day));
    }
    matches.push({ index: m.index, end: m.index + m[0].length, utcDate });
  }
  return matches;
}

const TRIGGER_WORD = /(between|by|on|at)((?:\s+\S+){0,2})\s*$/i;
// Trailing time-of-day + timezone (e.g. "at 12:00 pm ET") and/or a short
// parenthetical (e.g. "(Pacific time)", "(local kickoff)", "(CST, UTC+8)").
const TRAILING_CLAUSE = /^(\s+at\s+[\d:]+\s*(?:am|pm)?\s*[A-Za-z]{2,4}\b)?(\s*\([^)]{0,40}\))?/i;

function utcDateEquals(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
}

/**
 * Best-effort split of a market question into a timing clause and the
 * remaining resolution criteria. See markets/types.ts ParsedResolution for
 * the precision caveats (no timezone-aware time parsing).
 */
export function parseResolution(question: string, resolvesAt: Date | null): ParsedResolution {
  const trimmed = question.trim();
  const withoutTrailingQuestionMark = trimmed.endsWith("?") ? trimmed.slice(0, -1) : trimmed;

  const dateMatches = findDateMatches(withoutTrailingQuestionMark);

  if (dateMatches.length === 0) {
    return {
      rawQuestion: question,
      criteria: withoutTrailingQuestionMark,
      timingPhrase: null,
      timingDateHint: null,
      timingMatchesResolvesAt: null,
    };
  }

  const first = dateMatches[0]!;
  const last = dateMatches[dateMatches.length - 1]!;

  // Extend backward from the first date to catch a trigger word.
  const preContext = withoutTrailingQuestionMark.slice(Math.max(0, first.index - 25), first.index);
  const triggerMatch = TRIGGER_WORD.exec(preContext);
  const clauseStart = triggerMatch ? Math.max(0, first.index - 25) + triggerMatch.index : first.index;

  // Extend forward from the last date to catch a bounded trailing time/timezone clause.
  const postContext = withoutTrailingQuestionMark.slice(last.end, last.end + 60);
  const trailingMatch = TRAILING_CLAUSE.exec(postContext);
  const clauseEnd = trailingMatch ? last.end + trailingMatch[0].length : last.end;

  const timingPhrase = withoutTrailingQuestionMark.slice(clauseStart, clauseEnd).trim();
  const criteria = (withoutTrailingQuestionMark.slice(0, clauseStart) + withoutTrailingQuestionMark.slice(clauseEnd))
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.:;])/g, "$1")
    .trim();

  const timingDateHint = first.utcDate;
  const timingMatchesResolvesAt =
    timingDateHint && resolvesAt ? utcDateEquals(timingDateHint, resolvesAt) : null;

  return {
    rawQuestion: question,
    criteria: criteria || trimmed,
    timingPhrase: timingPhrase || null,
    timingDateHint,
    timingMatchesResolvesAt,
  };
}
