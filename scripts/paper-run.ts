/**
 * Phase 3 checkpoint driver: one PAPER decision pass over all live open
 * markets (signals -> candidate -> risk gate -> paper fill or skip-with-
 * reason), then a redeem/liquidate sweep demo (mocked, since none of the
 * live markets are terminal yet), then a portfolio/PnL summary and activity
 * counters. NO on-chain writes are ever sent — AGENT_MODE stays "paper".
 *
 * Usage: npm run paper-run
 */
import { AGENT_MODE, isLive, risk as riskConfig, layers as layersConfig, forecastBudget } from "../src/config/index.js";
import { runPaperPass } from "../src/loop/paperLoop.js";
import { PaperPortfolio } from "../src/portfolio/paperPortfolio.js";
import { sweepPosition } from "../src/execution/settlementSweep.js";
import { runRiskGate } from "../src/risk/gates.js";
import { executeTrade } from "../src/execution/paperTrade.js";
import { fetchOpenMarkets } from "../src/markets/fetch.js";
import type { TradeCandidate } from "../src/risk/types.js";
import { valuePositions, buildValuationContexts, type MarketValuationContext } from "../src/portfolio/valuation.js";

console.log(`=== PAPER run — AGENT_MODE=${AGENT_MODE} (isLive=${isLive()}) ===`);
console.log(
  `Layers: A=${layersConfig.aEnabled} B=${layersConfig.bEnabled} C=${layersConfig.cEnabled} D=${layersConfig.dEnabled} | F1(thinMarketFills)=${riskConfig.thinMarketFillsEnabled} | F2 dailyTokenBudget=${forecastBudget.dailyTokenBudget} stalenessMin=${forecastBudget.forecastStalenessMinutes}\n`
);

const portfolio = new PaperPortfolio(riskConfig.paperStartingBankroll);
const result = await runPaperPass(portfolio);

console.log("=== Per-market decisions ===\n");
for (const d of result.decisions) {
  const layerBits: string[] = [];
  if (d.layers.layerA) layerBits.push(`A:${d.layers.layerA.moved ? "MOVED" : "stable"}`);
  if (d.layers.layerB) layerBits.push(`B:${d.layers.layerB.isLongTail ? "long-tail" : "not-long-tail"}`);
  if (d.layers.layerC) layerBits.push(`C:${d.layers.layerC.withinMarketFlagged ? `DRIFT(${d.layers.layerC.drift})` : "ok"}`);
  if (d.layers.layerD) layerBits.push(`D:${d.layers.layerD.herdingDetected ? (d.layers.layerD.corroborated ? `CORROBORATED(+${d.layers.layerD.confidenceBump.toFixed(2)})` : "herding-but-not-corroborating") : "no-herd"}`);
  const layerSuffix = layerBits.length > 0 ? ` [${layerBits.join(" ")}]` : "";

  if (d.outcome === "traded") {
    console.log(`[TRADED]      ${d.market.address} | ${d.market.question.slice(0, 70)} | edge=${d.edge?.toFixed(4)}${layerSuffix}`);
  } else if (d.outcome === "no-candidate") {
    console.log(`[NO-SIGNAL]   ${d.market.address} | ${d.market.question.slice(0, 70)} | no outcome with positive edge and a usable signal${layerSuffix}`);
  } else {
    console.log(`[SKIP:${d.gate?.padEnd(13)}] ${d.market.address} | ${d.market.question.slice(0, 60)} | edge=${d.edge?.toFixed(4)} | ${d.reason}${layerSuffix}`);
  }
}

console.log("\n=== Layer C: cross-market coherence pairs ===\n");
if (!layersConfig.cEnabled) {
  console.log("Layer C disabled this run.");
} else if (result.coherencePairs.length === 0) {
  console.log("No related pairs found above the logging threshold (overlap >= 0.3) in the live market set.");
} else {
  for (const p of result.coherencePairs) {
    console.log(`${p.marketA} <-> ${p.marketB} | overlap=${p.overlap.toFixed(2)} nearDuplicate=${p.nearDuplicate} flagged=${p.flagged} | ${p.reason}`);
    if (p.arbitrageExecuted) {
      console.log(`  -> ARBITRAGE EXECUTED, expected profit ${p.arbitrageProfit?.toFixed(4)} TST`);
    }
  }
}

console.log("\n=== F2: forecast governor ===\n");
console.log(
  `Candidates needing a forecast: ${result.forecastGovernor.candidateCount} | forecasted: ${result.forecastGovernor.forecastedCount} | deferred (budget): ${result.forecastGovernor.deferredCount}`
);

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

// PAPER-ONLY FENCE (Phase 5 pre-live hardening): this block injects a FAKE
// probability/structured-resolution to force a candidate through the gate
// pipeline for demonstration purposes. If this script were ever run with
// AGENT_MODE=live, executeTrade's isLive() branch would send a REAL
// buyShares transaction sized off that fake data — an actual on-chain trade
// based on nothing real. This check makes that structurally impossible: the
// synthetic block simply does not execute outside PAPER, full stop, no
// matter what else changes in this file.
const demoMarkets = isLive() ? [] : await fetchOpenMarkets({ limit: 1 });
if (isLive()) {
  console.log("SKIPPED — synthetic-candidate injection is fenced to PAPER only and this process is running LIVE (AGENT_MODE=live). See the fence comment in scripts/paper-run.ts.");
} else if (demoMarkets.length > 0) {
  console.log(
    "Every real candidate this pass was stopped at gate (b) oracle-ambiguity — expected, since ANTHROPIC_API_KEY is unconfigured so every resolution is the degraded (non-LLM-structured) fallback, which always scores maximum ambiguity. That's honest, but it means gates c-f (edge/extremes/sizing/slippage) and a real fill never fired on real data. This demo forces a candidate past gates a+b with a SYNTHETIC probability/structured-resolution (clearly not a real signal) on a REAL live market address, so the quote/slippage/sizing/fill path underneath is proven against the actual chain, not mocked.\n"
  );
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
  const currentMarketExposure = [...portfolio.positions.values()]
    .filter((p) => p.marketAddress === demoMarket.address)
    .reduce((sum, p) => sum + p.costBasis, 0);
  const gateResult = await runRiskGate(syntheticCandidate, {
    structured: syntheticStructured,
    bankroll: portfolio.bankroll,
    currentTotalExposureTokens: currentExposure,
    currentMarketExposureTokens: currentMarketExposure,
  });

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
console.log(
  "Position valuation now uses portfolio/valuation.ts (Phase 5 pre-live hardening): open positions mark at spot (correct pre-close, per Phase 3), settled positions use the deterministic 1/0 LMSR payout (no call needed), and expired/failed positions use a real quoteLiquidate — never the old flat 'shares * last price' for a closed market. Any position that couldn't be valued this way falls back to cost basis and is flagged, not guessed — see hasProvisionalValuations below.\n"
);
const knownValuationContexts = new Map<string, MarketValuationContext>(
  result.decisions.map((d) => [d.market.address, { status: d.market.status, winningOutcomeIdx: d.market.winningOutcomeIdx, spotPrices: d.market.spotPrices }])
);
const valuationContexts = await buildValuationContexts([...portfolio.positions.values()], knownValuationContexts);
const valuations = await valuePositions([...portfolio.positions.values()], valuationContexts);
const summary = portfolio.summary(valuations);
console.log(JSON.stringify(summary, null, 2));

console.log("\n=== Activity counters (toward competition minimums) ===\n");
console.log("(computed from the REAL market pass only, BEFORE the synthetic demo trade — deliberately excludes it, since counting a synthetic demo toward real competition activity thresholds would misrepresent actual trading activity)\n");
console.log(JSON.stringify(result.activityCounters, null, 2));
if (!result.activityCounters.meetsTradeFloor || !result.activityCounters.meetsMarketFloor) {
  console.log("\nBelow minimum activity thresholds after this single pass. This loop does NOT force trades to pad these — deliberately, per the project brief (that's Phase 4 Layer F's job, informed by real edges, not this loop faking one).");
}
