/**
 * Layer C, part 1 — within-market coherence.
 *
 * Reuses the exact epsilon from markets/normalize.ts (not a re-derived
 * value) — this is the SAME check that already runs at intake
 * (NormalizedMarket.pricesSumToOne), just re-exposed with the actual drift
 * MAGNITUDE for reporting/flagging rather than only a boolean. On a real
 * LMSR market this should never drift beyond float noise — a real drift
 * would mean either a stale price read or something wrong with the network
 * config (see the Phase 0 healthcheck's original purpose).
 */
import type { NormalizedMarket } from "../../markets/types.js";
import { PRICE_SUM_EPSILON } from "../../markets/normalize.js";

export interface WithinMarketCoherence {
  drift: number | null; // |sum(prices) - 1|, null if prices unavailable
  flagged: boolean;
}

export function checkWithinMarketCoherence(market: NormalizedMarket): WithinMarketCoherence {
  if (!market.spotPrices || market.spotPrices.length === 0) {
    return { drift: null, flagged: false };
  }
  const sum = market.spotPrices.reduce((a, b) => a + b, 0);
  const drift = Math.abs(sum - 1);
  return { drift, flagged: drift > PRICE_SUM_EPSILON };
}
