/**
 * Phase 3 checkpoint driver: one PAPER decision pass over all live open
 * markets (signals -> candidate -> risk gate -> paper fill or skip-with-
 * reason), then a redeem/liquidate sweep demo (mocked, since none of the
 * live markets are terminal yet), then a portfolio/PnL summary and activity
 * counters. NO on-chain writes are ever sent — AGENT_MODE stays "paper".
 *
 * Usage: npm run paper-run
 */
import { AGENT_MODE, isLive, risk as riskConfig } from "../src/config/index.js";
import { runPaperPass } from "../src/loop/paperLoop.js";
import { PaperPortfolio } from "../src/portfolio/paperPortfolio.js";
import { sweepPosition } from "../src/execution/settlementSweep.js";
import { runRiskGate } from "../src/risk/gates.js";
import { executeTrade } from "../src/execution/paperTrade.js";
import { fetchOpenMarkets } from "../src/markets/fetch.js";
import type { TradeCandidate } from "../src/risk/types.js";

console.log(`=== PAPER run — AGENT_MODE=${AGENT_MODE} (isLive=${isLive()}) ===\n`);

const portfolio = new PaperPortfolio(riskConfig.paperStartingBankroll);
const result = await runPaperPass(portfolio);

console.log("=== Per-market decisions ===\n");
for (const d of result.decisions) {
  if (d.outcome === "traded") {
    console.log(`[TRADED]      ${d.market.address} | ${d.market.question.slice(0, 70)} | edge=${d.edge?.toFixed(4)}`);
  } else if (d.outcome === "no-candidate") {
    console.log(`[NO-SIGNAL]   ${d.market.address} | ${d.market.question.slice(0, 70)} | no outcome with positive edge and a usable signal`);
  } else {
    console.log(`[SKIP:${d.gate?.padEnd(13)}] ${d.market.address} | ${d.market.question.slice(0, 60)} | edge=${d.edge?.toFixed(4)} | ${d.reason}`);
  }
}

console.log("\n=== Simulated fills ===\n");
if (portfolio.trades.length === 0) {
  console.log("(none this pass — see skip reasons above; expected without ANTHROPIC_API_KEY/ODDS_API_KEY, since only 2/10 markets have any HIGH-quality signal at all — see Phase 2 checkpoint)");
} else {
  for (const t of portfolio.trades) {
    console.log(
      `BUY ${t.shares.toFixed(4)} shares of outcome[${t.outcomeIdx}] @ ${t.marketAddress} | quoted price=${t.quotedPrice.toFixed(4)} effective=${t.effectivePrice.toFixed(4)} slippage=${(t.slippagePct * 100).toFixed(2)}% | cost=${t.tokensIn.toFixed(4)} TST | our_prob=${t.ourProbability.toFixed(4)} edge=${t.edge.toFixed(4)}`
    );
  }
}

console.log("\n=== Synthetic demo: gates c-f + a real simulated fill ===\n");
console.log(
  "Every real candidate this pass was stopped at gate (b) oracle-ambiguity — expected, since ANTHROPIC_API_KEY is unconfigured so every resolution is the degraded (non-LLM-structured) fallback, which always scores maximum ambiguity. That's honest, but it means gates c-f (edge/extremes/sizing/slippage) and a real fill never fired on real data. This demo forces a candidate past gates a+b with a SYNTHETIC probability/structured-resolution (clearly not a real signal) on a REAL live market address, so the quote/slippage/sizing/fill path underneath is proven against the actual chain, not mocked.\n"
);

const demoMarkets = await fetchOpenMarkets({ limit: 1 });
if (demoMarkets.length > 0) {
  const demoMarket = demoMarkets[0]!;
  const demoPrice = demoMarket.spotPrices?.[0] ?? 0.5;
  const syntheticCandidate: TradeCandidate = {
    market: demoMarket,
    outcomeIdx: 0,
    price: demoPrice,
    probability: Math.min(0.95, demoPrice + 0.15), // synthetic: forces a real positive edge
    confidence: 0.9,
    edge: Math.min(0.95, demoPrice + 0.15) - demoPrice,
    consensusMatchQuality: "high", // synthetic — passes gate (a)
    hasForecast: true,
  };
  const syntheticStructured = {
    subject: "synthetic demo subject",
    condition: "synthetic demo condition, long enough to look crisp",
    comparatorOrThreshold: "synthetic >= threshold",
    sourceOfTruth: "synthetic demo source",
    resolutionTime: demoMarket.resolvesAt?.toISOString() ?? null,
    structuredByLLM: true, // synthetic — passes gate (b)
  };

  const currentExposure = [...portfolio.positions.values()].reduce((sum, p) => sum + p.costBasis, 0);
  const gateResult = await runRiskGate(syntheticCandidate, { structured: syntheticStructured, bankroll: portfolio.bankroll, currentTotalExposureTokens: currentExposure });

  if (gateResult.action === "trade") {
    const record = await executeTrade(gateResult.trade, portfolio);
    console.log(
      `[SYNTHETIC TRADE] ${demoMarket.address} | ${demoMarket.question.slice(0, 60)} | kellyFraction=${gateResult.trade.kellyFraction.toFixed(4)} | shares=${record.shares.toFixed(4)} | quoted=${record.quotedPrice.toFixed(4)} effective=${record.effectivePrice.toFixed(4)} slippage=${(record.slippagePct * 100).toFixed(3)}% | cost=${record.tokensIn.toFixed(4)} TST | edge=${record.edge.toFixed(4)}`
    );
  } else {
    console.log(`[SYNTHETIC SKIP:${gateResult.skip.gate}] ${gateResult.skip.reason}`);
  }
} else {
  console.log("(no open markets available to demo against)");
}

console.log("\n=== Redeem/liquidate sweep ===\n");
console.log("No live market is terminal yet (all 10 are status=open) — demonstrating both exit paths with MOCKED positions:\n");

const mockSettledMarket = "0x000000000000000000000000000000000settle" as `0x${string}`;
const settleRecord = await sweepPosition(mockSettledMarket, 0, 12.5, "settled", portfolio, {
  mocked: true,
  mockWinningOutcomeIdx: 0,
});
console.log(`[MOCKED settled -> redeemMarket] ${mockSettledMarket} outcome[0] (winning), 12.5 shares -> ${settleRecord?.tokensOut.toFixed(4)} TST redeemed`);

const mockExpiredMarket = "0x000000000000000000000000000000expired0" as `0x${string}`;
const liquidateRecord = await sweepPosition(mockExpiredMarket, 1, 8, "expired", portfolio, {
  mocked: true,
  mockLastPrice: 0.34,
});
console.log(`[MOCKED expired -> liquidate]    ${mockExpiredMarket} outcome[1], 8 shares -> ${liquidateRecord?.tokensOut.toFixed(4)} TST liquidated (approx. shares * last price, see settlementSweep.ts doc)`);

console.log("\nFreed capital is back in portfolio.bankroll immediately, redeployable on the next pass (see portfolio.bankroll below).\n");

console.log("=== Portfolio summary ===\n");
console.log("(includes the synthetic demo trade and mocked settlements above — this is the portfolio's actual state, not a real-activity-only view)\n");
const summary = portfolio.summary(result.pricesByMarket);
console.log(JSON.stringify(summary, null, 2));

console.log("\n=== Activity counters (toward competition minimums) ===\n");
console.log("(computed from the REAL market pass only, BEFORE the synthetic demo trade — deliberately excludes it, since counting a synthetic demo toward real competition activity thresholds would misrepresent actual trading activity)\n");
console.log(JSON.stringify(result.activityCounters, null, 2));
if (!result.activityCounters.meetsTradeFloor || !result.activityCounters.meetsMarketFloor) {
  console.log("\nBelow minimum activity thresholds after this single pass. This loop does NOT force trades to pad these — deliberately, per the project brief (that's Phase 4 Layer F's job, informed by real edges, not this loop faking one).");
}
