/**
 * One PAPER decision pass over all open markets: signals -> candidate
 * selection -> risk gate -> execute (paper) or skip. Tracks activity
 * counters toward the competition's minimum-activity thresholds but never
 * forces a bad trade to pad them — that's explicitly Phase 4 Layer F's job,
 * not this loop's.
 */
import { fetchOpenMarkets } from "../markets/fetch.js";
import { findConsensusMatch, shouldRunForecast } from "../signals/consensus/index.js";
import { structureResolution } from "../signals/forecasting/structureResolution.js";
import { forecastProbability } from "../signals/forecasting/forecast.js";
import { combineSignals } from "../signals/combine.js";
import { selectCandidate, runRiskGate } from "../risk/gates.js";
import { executeTrade } from "../execution/paperTrade.js";
import { PaperPortfolio } from "../portfolio/paperPortfolio.js";
import { activity } from "../config/index.js";
import type { NormalizedMarket } from "../markets/types.js";

export interface MarketDecisionLog {
  market: NormalizedMarket;
  outcome: "traded" | "no-candidate" | "skipped";
  gate?: string;
  reason?: string;
  edge?: number;
}

export interface PaperPassResult {
  decisions: MarketDecisionLog[];
  portfolio: PaperPortfolio;
  pricesByMarket: Map<string, number[]>;
  activityCounters: {
    distinctMarketsTraded: number;
    tradeCount: number;
    minTradesOverWindow: number;
    minDistinctMarkets: number;
    meetsTradeFloor: boolean;
    meetsMarketFloor: boolean;
  };
}

export async function runPaperPass(portfolio: PaperPortfolio): Promise<PaperPassResult> {
  const markets = await fetchOpenMarkets({ limit: 50 });
  const decisions: MarketDecisionLog[] = [];
  const pricesByMarket = new Map<string, number[]>();

  for (const market of markets) {
    pricesByMarket.set(market.address, market.spotPrices ?? market.outcomes.map(() => NaN));

    const { match: consensus } = await findConsensusMatch(market);
    const structured = await structureResolution(market);
    const forecast = shouldRunForecast(consensus) ? await forecastProbability(market, structured) : null;
    const combined = combineSignals(market.spotPrices ?? market.outcomes.map(() => NaN), consensus, forecast);

    const candidate = selectCandidate(market, combined);
    if (!candidate) {
      decisions.push({ market, outcome: "no-candidate" });
      continue;
    }

    const currentTotalExposureTokens = [...portfolio.positions.values()].reduce((sum, p) => sum + p.costBasis, 0);
    const gateResult = await runRiskGate(candidate, { structured, bankroll: portfolio.bankroll, currentTotalExposureTokens });

    if (gateResult.action === "skip") {
      decisions.push({ market, outcome: "skipped", gate: gateResult.skip.gate, reason: gateResult.skip.reason, edge: candidate.edge });
      continue;
    }

    if (!portfolio.canAfford(gateResult.trade.finalTokensIn)) {
      decisions.push({ market, outcome: "skipped", gate: "sizing", reason: `insufficient paper bankroll (${portfolio.bankroll.toFixed(4)} TST < ${gateResult.trade.finalTokensIn.toFixed(4)} TST needed)`, edge: candidate.edge });
      continue;
    }

    await executeTrade(gateResult.trade, portfolio);
    decisions.push({ market, outcome: "traded", edge: candidate.edge });
  }

  const distinctMarketsTraded = portfolio.distinctMarketsTraded();
  const tradeCount = portfolio.trades.length;

  return {
    decisions,
    portfolio,
    pricesByMarket,
    activityCounters: {
      distinctMarketsTraded,
      tradeCount,
      minTradesOverWindow: activity.minTradesOverWindow,
      minDistinctMarkets: activity.minDistinctMarkets,
      meetsTradeFloor: tradeCount >= activity.minTradesOverWindow,
      meetsMarketFloor: distinctMarketsTraded >= activity.minDistinctMarkets,
    },
  };
}
