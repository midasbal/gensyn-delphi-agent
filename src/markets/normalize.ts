import type { Market } from "../sdk/client.js";
import type { NormalizedMarket } from "./types.js";
import { classifyDomain } from "./classify.js";
import { parseResolution } from "./parseResolution.js";

/** Exported so layers/coherence/withinMarket.ts can reuse the exact same epsilon rather than redefining it. */
export const PRICE_SUM_EPSILON = 1e-6;

function sumToOne(prices: number[] | null): boolean | null {
  if (!prices || prices.length === 0) return null;
  const sum = prices.reduce((acc, p) => acc + p, 0);
  return Math.abs(sum - 1) <= PRICE_SUM_EPSILON;
}

/** Normalizes a raw SDK Market into the agent's internal shape. Pure — no I/O. */
export function normalizeMarket(market: Market): NormalizedMarket {
  const meta = market.metadata;
  const question = meta?.question ?? "";
  const outcomes = meta?.outcomes ?? [];
  const category = market.category ?? "";
  const resolvesAt = market.resolvesAt ? new Date(market.resolvesAt) : null;

  return {
    address: market.id as `0x${string}`,
    appMarketId: market.appMarketId,
    marketUrl: market.marketUrl,
    status: market.status,
    category,
    domain: classifyDomain(category, question),
    question,
    outcomes,
    outcomeCount: outcomes.length,
    spotPrices: market.spotPrices ?? null,
    spotImpliedProbabilities: market.spotImpliedProbabilities ?? null,
    pricesSumToOne: sumToOne(market.spotPrices ?? null),
    tradingFeePct: market.tradingFee ? (Number(market.tradingFee) / 1e18) * 100 : null,
    verifiable: market.verifiable,
    createdAt: new Date(market.createdAt),
    resolvesAt,
    settlesAt: market.settlesAt ? new Date(market.settlesAt) : null,
    winningOutcomeIdx: market.winningOutcomeIdx !== null ? Number(market.winningOutcomeIdx) : null,
    resolution: parseResolution(question, resolvesAt),
    raw: market,
  };
}
