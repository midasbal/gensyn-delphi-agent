/**
 * Layer C, part 2 — cross-market coherence.
 *
 * Relatedness is detected via word-overlap on the structured resolution's
 * `subject` (falls back to the raw question when no subject is available)
 * — reusing signals/consensus/textMatch.ts's wordOverlapScore rather than a
 * new metric. Two tiers, per the project brief ("start conservative... log
 * the rest for review"):
 *   - HIGH_RELATED_THRESHOLD: confident enough to actually check for
 *     incoherence / consider pairing.
 *   - LOGGED_THRESHOLD: below the confident bar but still worth a log line
 *     for a human to review — never acted on.
 *
 * Joint incoherence is intentionally scoped narrowly: this only asserts an
 * "expected relationship" between two markets' probabilities for the
 * NEAR-DUPLICATE case (overlap >= NEAR_DUPLICATE_THRESHOLD — i.e. they
 * appear to be asking essentially the same question), where the expected
 * relationship is simply "equal". General complementary-market arbitrage
 * (negated/opposite framings, e.g. "X happens" vs "X doesn't happen" as two
 * SEPARATE markets) needs real semantic understanding of the negation this
 * code cannot verify safely from word overlap alone — a false positive
 * there would size a trade against a pair that isn't actually
 * complementary, which is worse than the missed opportunity of not
 * building it. Deliberately not attempted.
 *
 * planArbitragePair() only ever fires on a flagged near-duplicate
 * incoherence — see the Phase 4 checkpoint report for confirmation this
 * has never fired on live data (the current 10-market set has no
 * duplicates).
 */
import type { NormalizedMarket } from "../../markets/types.js";
import type { StructuredResolution } from "../../signals/forecasting/types.js";
import { wordOverlapScore } from "../../signals/consensus/textMatch.js";

const HIGH_RELATED_THRESHOLD = 0.6;
const LOGGED_THRESHOLD = 0.3;
const NEAR_DUPLICATE_THRESHOLD = 0.85;
const PROBABILITY_DIVERGENCE_TOLERANCE = 0.1;

export interface MarketWithSubject {
  market: NormalizedMarket;
  subject: string;
}

export function toSubjectCandidate(market: NormalizedMarket, structured?: StructuredResolution): MarketWithSubject {
  return { market, subject: structured?.subject || market.resolution.criteria || market.question };
}

export type PairConfidence = "high" | "logged-only";

export interface RelatedPair {
  a: MarketWithSubject;
  b: MarketWithSubject;
  overlap: number;
  confidence: PairConfidence;
  nearDuplicate: boolean;
}

/** Pure — O(n^2) pairwise comparison over the given candidate set. Fine at competition scale (tens of markets, not thousands). */
export function findRelatedPairs(candidates: MarketWithSubject[]): RelatedPair[] {
  const pairs: RelatedPair[] = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i]!;
      const b = candidates[j]!;
      const overlap = wordOverlapScore(a.subject, b.subject);
      if (overlap < LOGGED_THRESHOLD) continue;
      pairs.push({
        a,
        b,
        overlap,
        confidence: overlap >= HIGH_RELATED_THRESHOLD ? "high" : "logged-only",
        nearDuplicate: overlap >= NEAR_DUPLICATE_THRESHOLD,
      });
    }
  }
  return pairs;
}

export interface IncoherenceFlag {
  pair: RelatedPair;
  divergence: number;
  flagged: boolean;
  reason: string;
}

/** Only evaluates near-duplicate, high-confidence pairs — see file header for why. */
export function detectJointIncoherence(pair: RelatedPair): IncoherenceFlag | null {
  if (pair.confidence !== "high" || !pair.nearDuplicate) return null;

  const priceA = pair.a.market.spotPrices?.[0];
  const priceB = pair.b.market.spotPrices?.[0];
  if (priceA === undefined || priceB === undefined) return null;

  const divergence = Math.abs(priceA - priceB);
  const flagged = divergence > PROBABILITY_DIVERGENCE_TOLERANCE;
  return {
    pair,
    divergence,
    flagged,
    reason: flagged
      ? `near-duplicate markets (overlap=${pair.overlap.toFixed(2)}) price outcome[0] at ${priceA.toFixed(3)} vs ${priceB.toFixed(3)} — divergence ${divergence.toFixed(3)} > tolerance ${PROBABILITY_DIVERGENCE_TOLERANCE}`
      : `near-duplicate markets agree closely enough (divergence ${divergence.toFixed(3)})`,
  };
}
