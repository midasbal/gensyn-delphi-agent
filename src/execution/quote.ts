/**
 * Quote-first sizing: always quotes the intended size via the REAL on-chain
 * quoteBuy (a read call — safe in both PAPER and LIVE, no signature/tx
 * required) before any trade is considered final. If the quote reverts
 * (shallow LMSR depth) or shows slippage beyond tolerance, the size is
 * halved and re-quoted, down to a floor. This is what risk/gates.ts step
 * (f) calls, and what execution/paperTrade.ts uses to book a simulated fill
 * — both PAPER and LIVE quote identically; only the ensuing buyShares call
 * differs (and LIVE's is gated on isLive() — see paperTrade.ts).
 */
import { quoteBuy } from "../sdk/client.js";
import { risk } from "../config/index.js";

export interface QuoteClipResult {
  finalShares: number;
  finalTokensIn: number;
  effectivePrice: number;
  slippagePct: number;
  attempts: number;
}

const sharesToBigint = (n: number): bigint => BigInt(Math.round(n * 1e18));
const MAX_ATTEMPTS = 6;
const MIN_SHARES_FLOOR = 0.01;

export async function quoteWithSlippageClip(
  marketAddress: `0x${string}`,
  outcomeIdx: number,
  desiredShares: number,
  referencePrice: number,
  slippageToleranceBps: number = risk.defaultSlippageBps
): Promise<QuoteClipResult | null> {
  let shares = desiredShares;
  const tolerance = slippageToleranceBps / 10_000;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (shares < MIN_SHARES_FLOOR) return null;

    try {
      const { tokensIn } = await quoteBuy(marketAddress, outcomeIdx, sharesToBigint(shares));
      const tokensInHuman = Number(tokensIn) / 1e6;
      const effectivePrice = tokensInHuman / shares;
      const slippagePct = referencePrice > 0 ? (effectivePrice - referencePrice) / referencePrice : 0;

      if (slippagePct <= tolerance) {
        return { finalShares: shares, finalTokensIn: tokensInHuman, effectivePrice, slippagePct, attempts: attempt };
      }
    } catch {
      // Quote reverted — almost always shallow LMSR depth saturating on this size. Cut size and retry.
    }
    shares = shares / 2;
  }

  return null;
}
