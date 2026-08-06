import type { Market, MarketStatus } from "../sdk/client.js";

/**
 * Coarse topic classification, used to route markets to signal sources
 * (Phase 2) and to pick research depth (Phase 4 long-tail routing).
 *
 * Deliberately an OPEN string, not a closed union: the API's own `category`
 * field is the PRIMARY source and is not limited to its documented enum
 * (crypto/culture/economics/miscellaneous/politics/sports) — live data has
 * already returned "tech". `domain` only falls back to a keyword pass over
 * the question text when category is empty or "miscellaneous", so an obvious
 * bucket (weather, tech/AI) isn't lost inside the catch-all. Consumers MUST
 * treat an unrecognized domain string as "no domain-specific adapter
 * applies" and route to the generic/forecasting path — never throw on an
 * unknown value. See markets/classify.ts.
 */
export type MarketDomain = string;

/**
 * Best-effort decomposition of a market's free-text question into a timing
 * clause (when it resolves, as written) and the remaining criteria (what
 * determines the outcome). This is NOT a substitute for the structured
 * `resolvesAt`/`settlesAt` timestamps already on the Market object — those
 * remain authoritative for scheduling. `timingDateHint` is a sanity
 * cross-check against `resolvesAt`'s calendar date, not a precise timestamp:
 * it deliberately does not attempt timezone-aware parsing of abbreviations
 * like "ET"/"PT"/"CST" embedded in the question text, since that parsing is
 * ambiguous (DST, non-JS-standard abbreviations) and a wrong precise time is
 * worse than an honest "unknown".
 */
export interface ParsedResolution {
  /** The full, unmodified question text. */
  rawQuestion: string;
  /** The question with the extracted timing clause removed — the resolution criteria. */
  criteria: string;
  /** The raw substring identified as the timing/deadline clause, if any. */
  timingPhrase: string | null;
  /** Calendar-date-only (UTC midnight) best-effort parse of timingPhrase. Null if unparseable. */
  timingDateHint: Date | null;
  /** True/false if timingDateHint's UTC calendar date matches resolvesAt's; null if either is missing. */
  timingMatchesResolvesAt: boolean | null;
}

export interface NormalizedMarket {
  /** Market proxy address — pass as marketAddress to every SDK trading/quote call. */
  address: `0x${string}`;
  appMarketId: string;
  marketUrl: string;
  status: MarketStatus;
  /** Raw API category, "" if the API returned none. */
  category: string;
  domain: MarketDomain;
  question: string;
  outcomes: string[];
  outcomeCount: number;
  /** Human-readable float per outcome, e.g. 0.62 = 0.62 TST/share. Null if not fetched. */
  spotPrices: number[] | null;
  /** 0-1 float per outcome. On this LMSR competition, equal to spotPrices. Null if not fetched. */
  spotImpliedProbabilities: number[] | null;
  /** Sum of spotPrices vs 1, within a tight epsilon. Null if prices weren't fetched. */
  pricesSumToOne: boolean | null;
  tradingFeePct: number | null;
  verifiable: boolean;
  createdAt: Date;
  resolvesAt: Date | null;
  settlesAt: Date | null;
  winningOutcomeIdx: number | null;
  resolution: ParsedResolution;
  /** The untouched SDK Market object, for anything not surfaced above. */
  raw: Market;
}
