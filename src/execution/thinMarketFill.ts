/**
 * F1 — thin-market fill rule. Replaces gate f's Phase 3 hard-skip when
 * risk.thinMarketFillsEnabled is true (default false — see config/index.ts).
 *
 * Two distinct floors:
 *   - HARD floor (risk.hardMinShares): share granularity / smallest
 *     reliable size. NEVER filled below this, no matter what — this is a
 *     technical limit, not a policy choice.
 *   - SOFT floor (risk.dustThresholdTokens, expressed in shares via the
 *     reference price): the Phase 3 "not worth the gas/attention" policy
 *     minimum. This rule is explicitly allowed to fill BELOW it — a smaller
 *     profitable position in a thin market is better than skipping
 *     entirely, since depth (not conviction) is the binding constraint
 *     here.
 *
 * Steps size down (geometric halving, same style as execution/quote.ts's
 * quoteWithSlippageClip) to the largest size whose QUOTED average fill
 * price both (a) keeps slippage within tolerance and (b) still clears the
 * edge threshold AT THAT ACTUAL PRICE — smaller size means less LMSR price
 * impact, so the effective price moves back toward spot and edge recovers,
 * but it must be rechecked, never assumed. If no size >= hardMinShares
 * satisfies both, returns null (skip) — same as the old hard-skip path.
 */
import { quoteBuy as sdkQuoteBuy } from "../sdk/client.js";

const MAX_ATTEMPTS = 8;

export interface ThinMarketFillResult {
  finalShares: number;
  finalTokensIn: number;
  effectivePrice: number;
  slippagePct: number;
  recomputedEdge: number;
  steppedBelowSoftFloor: boolean;
}

export interface ThinQuoteFn {
  (marketAddress: `0x${string}`, outcomeIdx: number, shares: number): Promise<{ tokensIn: number }>;
}

/** Real quote path — wraps sdk/client.ts's quoteBuy (18-decimal bigint shares, 6-decimal bigint tokensIn) into the human-unit ThinQuoteFn shape. */
export const realQuoteBuy: ThinQuoteFn = async (marketAddress, outcomeIdx, shares) => {
  const { tokensIn } = await sdkQuoteBuy(marketAddress, outcomeIdx, BigInt(Math.round(shares * 1e18)));
  return { tokensIn: Number(tokensIn) / 1e6 };
};

/** `quoteBuy` is injected so this is unit-testable without hitting the chain — risk/gates.ts passes `realQuoteBuy`. */
export async function resolveThinMarketFill(
  marketAddress: `0x${string}`,
  outcomeIdx: number,
  desiredShares: number,
  referencePrice: number,
  ourProbability: number,
  effectiveEdgeThreshold: number,
  slippageTolerance: number,
  hardMinShares: number,
  softMinShares: number,
  quoteBuy: ThinQuoteFn = realQuoteBuy
): Promise<ThinMarketFillResult | null> {
  let shares = desiredShares;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (shares < hardMinShares) return null;

    try {
      const { tokensIn: tokensInHuman } = await quoteBuy(marketAddress, outcomeIdx, shares);
      const effectivePrice = tokensInHuman / shares;
      const slippagePct = referencePrice > 0 ? (effectivePrice - referencePrice) / referencePrice : 0;
      const recomputedEdge = ourProbability - effectivePrice;

      if (Math.abs(slippagePct) <= slippageTolerance && recomputedEdge >= effectiveEdgeThreshold) {
        return {
          finalShares: shares,
          finalTokensIn: tokensInHuman,
          effectivePrice,
          slippagePct,
          recomputedEdge,
          steppedBelowSoftFloor: shares < softMinShares,
        };
      }
    } catch {
      // Quote reverted — shallow LMSR depth saturating at this size. Cut and retry.
    }
    shares = shares / 2;
  }

  return null;
}
