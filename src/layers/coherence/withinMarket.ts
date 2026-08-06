/**
 * Layer C, part 1 — within-market coherence.
 *
 * DIAGNOSTIC ONLY. NEVER a trade trigger, never used for sizing. LMSR
 * mechanically enforces outcome prices summing to 1 (competition.md) — a
 * measured deviation here is a floating-point representation artifact (the
 * decimal-adjusted floats markets.md documents), not a mispricing and
 * NOT arbitrage. There is nothing to buy or sell against a rounding error
 * on a single market's own price vector. This is a sanity check on our own
 * data pipeline (are we reading fresh, correctly-summed prices?), logged
 * for review — see the Phase 4 checkpoint report, which caught this exact
 * ~1e-6 float artifact on two live markets and correctly took no action on
 * it.
 *
 * Only Layer C's ACROSS-market path (acrossMarket.ts / arbitragePair.ts)
 * is ever allowed to size a trade — that one compares two INDEPENDENT
 * markets' prices, where a real, tradeable inconsistency can genuinely
 * exist. Deliberately no plumbing connects this file's output to
 * risk/gates.ts or execution/ — see loop/paperLoop.ts, where the result of
 * checkWithinMarketCoherence() is only ever placed into a decision LOG.
 *
 * Reuses the exact epsilon from markets/normalize.ts (not a re-derived
 * value) — this is the SAME check that already runs at intake
 * (NormalizedMarket.pricesSumToOne), just re-exposed with the actual drift
 * MAGNITUDE for logging rather than only a boolean.
 */
import type { NormalizedMarket } from "../../markets/types.js";
import { PRICE_SUM_EPSILON } from "../../markets/normalize.js";

export interface WithinMarketDiagnostic {
  drift: number | null; // |sum(prices) - 1|, null if prices unavailable
  /** Worth a human glance in the logs — NOT a trade signal. See file header. */
  flaggedForReview: boolean;
}

export function checkWithinMarketCoherence(market: NormalizedMarket): WithinMarketDiagnostic {
  if (!market.spotPrices || market.spotPrices.length === 0) {
    return { drift: null, flaggedForReview: false };
  }
  const sum = market.spotPrices.reduce((a, b) => a + b, 0);
  const drift = Math.abs(sum - 1);
  return { drift, flaggedForReview: drift > PRICE_SUM_EPSILON };
}
