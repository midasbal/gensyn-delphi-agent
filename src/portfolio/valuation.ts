/**
 * Real per-position valuation, replacing the naive "shares * last price"
 * that was previously applied uniformly regardless of market status (Phase
 * 5 pre-live hardening — the project brief called this out specifically as
 * MOCK accounting that needed replacing before going live).
 *
 * Method by status:
 *   - open / awaiting_settlement: shares * live spot price. This one IS
 *     correct as spot — Phase 3's docs already established that spot only
 *     misrepresents value once a market closes, not before.
 *   - settled: NOT a network call. A winning share pays EXACTLY 1 TST, a
 *     losing share pays 0 — this is deterministic per competition.md's LMSR
 *     rules, and market.winningOutcomeIdx is already free (fetched at
 *     intake), so there's no reason to guess OR to make a redundant
 *     quoteRedeem call — the payout is arithmetic, not a quote.
 *   - expired / failed (LIQUIDATABLE_MARKET_STATUSES): genuinely NOT
 *     deterministic — liquidation proceeds depend on the LMSR pool state at
 *     liquidation time, so this calls the real quoteLiquidate.
 *
 * If a value can't be determined (winningOutcomeIdx unexpectedly missing on
 * a "settled" market, quoteLiquidate reverts, spot price unavailable), the
 * position is marked `provisional: true` and falls back to cost basis —
 * never a guessed number presented as real. Callers (PaperPortfolio.summary)
 * surface `provisional` so a report can flag it rather than silently trust it.
 */
import { quoteLiquidate as sdkQuoteLiquidate, getMarketByAddress, LIQUIDATABLE_MARKET_STATUSES, type MarketStatus } from "../sdk/client.js";
import type { Position } from "./types.js";

export interface MarketValuationContext {
  status: MarketStatus;
  winningOutcomeIdx: number | null;
  spotPrices: number[] | null;
}

export type ValuationMethod = "spot" | "settled-payout" | "quoteLiquidate" | "provisional";

export interface PositionValuation {
  value: number;
  method: ValuationMethod;
  provisional: boolean;
}

/** `quoteLiquidate` is injected for testability — defaults to the real sdk call. */
export async function valuePosition(
  position: Position,
  market: MarketValuationContext | undefined,
  quoteLiquidateFn: typeof sdkQuoteLiquidate = sdkQuoteLiquidate
): Promise<PositionValuation> {
  if (!market) {
    return { value: position.costBasis, method: "provisional", provisional: true };
  }

  if (market.status === "open" || market.status === "awaiting_settlement") {
    const spot = market.spotPrices?.[position.outcomeIdx];
    if (spot === undefined) return { value: position.costBasis, method: "provisional", provisional: true };
    return { value: position.shares * spot, method: "spot", provisional: false };
  }

  if (market.status === "settled") {
    if (market.winningOutcomeIdx === null) {
      // Shouldn't happen for a genuinely settled market, but don't guess if it does.
      return { value: position.costBasis, method: "provisional", provisional: true };
    }
    const value = position.outcomeIdx === market.winningOutcomeIdx ? position.shares * 1 : 0;
    return { value, method: "settled-payout", provisional: false };
  }

  if (LIQUIDATABLE_MARKET_STATUSES.includes(market.status)) {
    try {
      const { totalTokensOut } = await quoteLiquidateFn(position.marketAddress, [position.outcomeIdx]);
      return { value: Number(totalTokensOut) / 1e6, method: "quoteLiquidate", provisional: false };
    } catch {
      return { value: position.costBasis, method: "provisional", provisional: true };
    }
  }

  return { value: position.costBasis, method: "provisional", provisional: true };
}

/**
 * A position's market may no longer appear in the current pass's "open"
 * fetch (fetchOpenMarkets only returns status=open — a market that has
 * since settled/expired drops out of that list entirely). This fills in a
 * MarketValuationContext for any position whose market isn't already known,
 * via a direct getMarket call — so a closed-out market's position still
 * gets valued correctly instead of silently falling through to
 * "provisional" for the wrong reason (market unknown, not unvaluable).
 */
export async function buildValuationContexts(
  positions: Position[],
  known: Map<string, MarketValuationContext>,
  fetchMarket: (address: string) => Promise<Awaited<ReturnType<typeof getMarketByAddress>>> = getMarketByAddress
): Promise<Map<string, MarketValuationContext>> {
  const result = new Map(known);
  for (const position of positions) {
    if (result.has(position.marketAddress)) continue;
    try {
      const market = await fetchMarket(position.marketAddress);
      result.set(position.marketAddress, {
        status: market.status,
        winningOutcomeIdx: market.winningOutcomeIdx !== null ? Number(market.winningOutcomeIdx) : null,
        spotPrices: market.spotPrices ?? null,
      });
    } catch {
      // Leave unset — valuePosition() marks this position provisional (fetch failed, not "unvaluable").
    }
  }
  return result;
}

/** Values every position, keyed the same way PaperPortfolio keys them internally (`${marketAddress}-${outcomeIdx}`). */
export async function valuePositions(
  positions: Position[],
  marketsByAddress: Map<string, MarketValuationContext>,
  quoteLiquidateFn: typeof sdkQuoteLiquidate = sdkQuoteLiquidate
): Promise<Map<string, PositionValuation>> {
  const result = new Map<string, PositionValuation>();
  for (const position of positions) {
    const key = `${position.marketAddress}-${position.outcomeIdx}`;
    result.set(key, await valuePosition(position, marketsByAddress.get(position.marketAddress), quoteLiquidateFn));
  }
  return result;
}
