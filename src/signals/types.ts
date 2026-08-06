/**
 * Shared per-outcome signal shape, used by both consensus/ and forecasting/
 * so a market with N outcomes (not just binary Yes/No) can be represented
 * without a special case. Binary is just the N=2 case.
 */

export type MatchQuality = "high" | "medium";

export interface OutcomeEstimate {
  /** Null if this specific outcome could not be estimated. */
  probability: number | null;
  /** 0 if probability is null. */
  confidence: number;
}

export function isFullyEstimated(outcomes: OutcomeEstimate[]): boolean {
  return outcomes.length > 0 && outcomes.every((o) => o.probability !== null);
}

export function estimatedCount(outcomes: OutcomeEstimate[]): number {
  return outcomes.filter((o) => o.probability !== null).length;
}

/**
 * Builds a per-outcome distribution from a single named outcome's estimate.
 *
 * For a 2-outcome (binary) market, the complementary outcome is DERIVED
 * exactly (1 - probability) — this is not a guess, probabilities over a
 * binary market's two outcomes must sum to 1, so this is just arithmetic.
 *
 * For an N>2 outcome market, only the named outcome is filled; every other
 * index is left null. Sophisticated multi-outcome consensus mapping
 * (distributing the remainder across N-1 other outcomes) is deliberately
 * NOT attempted here — there is no live multi-outcome market to validate
 * that logic against yet (the current competition set is all binary). A
 * caller receiving a partially-filled distribution like this must treat it
 * as "only one outcome could be estimated" (see isFullyEstimated /
 * estimatedCount) and size/trade only the outcome that has a real number.
 */
export function distributionFromSingleOutcome(
  outcomeIdx: number,
  probability: number,
  confidence: number,
  outcomeCount: number
): OutcomeEstimate[] {
  const outcomes: OutcomeEstimate[] = Array.from({ length: outcomeCount }, () => ({ probability: null, confidence: 0 }));
  outcomes[outcomeIdx] = { probability, confidence };
  if (outcomeCount === 2) {
    const other = outcomeIdx === 0 ? 1 : 0;
    outcomes[other] = { probability: 1 - probability, confidence };
  }
  return outcomes;
}
