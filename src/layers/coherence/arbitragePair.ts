/**
 * Layer C, part 3 — coherent-arbitrage pair sizing.
 *
 * Only ever called on an IncoherenceFlag from detectJointIncoherence()
 * (near-duplicate markets, i.e. believed to share the same real-world
 * resolution). Given that assumption, the arbitrage is the standard
 * complementary-outcome structure: buy outcome[0] ("Yes") on whichever
 * market prices it cheaper, and buy outcome[1] ("No") on the other — if
 * both markets genuinely resolve identically, exactly one leg pays 1 no
 * matter what happens, so total cost < 1 is a riskless profit of
 * (expensive market's Yes price - cheap market's Yes price).
 *
 * That "genuinely resolve identically" assumption is NOT verified beyond
 * text similarity (acrossMarket.ts's near-duplicate threshold) — two
 * questions can read almost identically and still differ on timing or
 * exact criteria. This is why the caller only invokes this on
 * confidence:"high" + nearDuplicate pairs, and why it's a LAST resort
 * behind the coherence layer's own conservative thresholds, not a general
 * arbitrage bot. Restricted to binary (2-outcome) markets — the
 * complementary structure above doesn't generalize cleanly to N>2 outcomes,
 * so a non-binary pair returns null (not applicable) rather than guessing.
 *
 * NEVER fired on live data this phase — the current 10-market competition
 * set has no duplicate/near-duplicate questions. Validated with synthetic,
 * dependency-injected quotes in tests/layers.test.ts instead.
 */
import type { NormalizedMarket } from "../../markets/types.js";
import type { IncoherenceFlag } from "./acrossMarket.js";
import { risk } from "../../config/index.js";

export interface QuoteFn {
  (marketAddress: `0x${string}`, outcomeIdx: number, shares: number): Promise<{ tokensIn: number }>;
}

export interface ArbitragePlan {
  cheapMarket: NormalizedMarket;
  expensiveMarket: NormalizedMarket;
  shares: number;
  costCheapLeg: number;
  costExpensiveLeg: number;
  totalCost: number;
  guaranteedPayout: number;
  expectedProfit: number;
  profitPerShare: number;
  slippageCheapLeg: number;
  slippageExpensiveLeg: number;
}

/**
 * `quoteBuy` is injected so this is unit-testable without hitting the
 * chain — execution code (loop/paperLoop.ts) passes the real sdk quoteBuy
 * wrapped to return human-unit tokensIn.
 */
export async function planArbitragePair(flag: IncoherenceFlag, desiredShares: number, quoteBuy: QuoteFn): Promise<ArbitragePlan | null> {
  if (!flag.flagged) return null;

  const { a, b } = flag.pair;
  if (a.market.outcomeCount !== 2 || b.market.outcomeCount !== 2) return null;

  const priceA = a.market.spotPrices?.[0];
  const priceB = b.market.spotPrices?.[0];
  if (priceA === undefined || priceB === undefined) return null;

  const cheapMarket = priceA < priceB ? a.market : b.market;
  const expensiveMarket = priceA < priceB ? b.market : a.market;

  const [cheapQuote, expensiveQuote] = await Promise.all([
    quoteBuy(cheapMarket.address, 0, desiredShares).catch(() => null),
    quoteBuy(expensiveMarket.address, 1, desiredShares).catch(() => null),
  ]);
  if (!cheapQuote || !expensiveQuote) return null;

  const effectiveCheap = cheapQuote.tokensIn / desiredShares;
  const effectiveExpensive = expensiveQuote.tokensIn / desiredShares;
  const spotCheap = cheapMarket.spotPrices![0]!;
  const spotExpensive = 1 - expensiveMarket.spotPrices![0]!; // outcome[1] price = 1 - outcome[0] price on a binary LMSR market
  const slippageCheapLeg = spotCheap > 0 ? (effectiveCheap - spotCheap) / spotCheap : 0;
  const slippageExpensiveLeg = spotExpensive > 0 ? (effectiveExpensive - spotExpensive) / spotExpensive : 0;

  if (Math.abs(slippageCheapLeg) > risk.slippageTolerance || Math.abs(slippageExpensiveLeg) > risk.slippageTolerance) {
    return null; // doesn't pass slippage on both legs
  }

  const totalCost = cheapQuote.tokensIn + expensiveQuote.tokensIn;
  const guaranteedPayout = desiredShares * 1; // exactly 1 token/share, LMSR competition — see competition.md
  const expectedProfit = guaranteedPayout - totalCost;
  const profitPerShare = expectedProfit / desiredShares;

  if (profitPerShare < risk.edgeThreshold) return null; // recomputed at actual fill price — must still clear the bar

  return {
    cheapMarket,
    expensiveMarket,
    shares: desiredShares,
    costCheapLeg: cheapQuote.tokensIn,
    costExpensiveLeg: expensiveQuote.tokensIn,
    totalCost,
    guaranteedPayout,
    expectedProfit,
    profitPerShare,
    slippageCheapLeg,
    slippageExpensiveLeg,
  };
}
