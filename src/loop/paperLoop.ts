/**
 * One PAPER decision pass over all open markets, now wired with Phase 4's
 * layers — each one only feeds the risk gate or the signal combiner, never
 * trades on its own:
 *
 *   Layer A (latency): pure move-check against the last-acted baseline
 *   (reusing the consensus/price data this pass already fetched — no
 *   duplicate LLM-free API calls) reorders the market queue; recordActedReference()
 *   stamps a baseline for whatever pass comes next (meaningful once Phase 5
 *   makes this a persistent process).
 *
 *   Layer B (long-tail): classifies each no-consensus market; feeds F2's
 *   ranking (long-tail markets get forecast priority) — never trades.
 *
 *   Layer C (coherence): within-market drift is logged per market
 *   (reusing the Phase 1 epsilon check). Across-market relatedness/
 *   incoherence runs once over the whole batch after structuring; a
 *   genuine high-confidence flagged pair is sized and, if it clears
 *   slippage on both legs, both legs are booked as a single PAPER trade —
 *   see the Phase 4 checkpoint report for confirmation this has never
 *   fired live (no near-duplicate markets exist yet).
 *
 *   Layer D (opponents): per selected candidate, checks the public trade
 *   feed for a herding burst on the OPPOSITE outcome and, only then, adds a
 *   small capped confidence bump before gate (a) — never a standalone signal.
 *
 *   F2 (forecast governor): batches every no-consensus market's forecast
 *   need, ranks it, and only calls the LLM for as many as the rolling
 *   token budget allows — deferred markets simply get no forecast this
 *   pass (their combined signal falls back to consensus-only or null,
 *   exactly as if forecasting were unconfigured for them this time).
 *
 * F1 (thin-market fills) lives entirely inside risk/gates.ts's gate (f) —
 * nothing to wire here beyond the config flag already read there.
 *
 * Activity counters remain a side-effect only — this loop never forces a
 * trade to pad them (Phase 4 Layer F wave 2's job, not built yet).
 */
import { fetchOpenMarkets } from "../markets/fetch.js";
import { findConsensusMatch, shouldRunForecast } from "../signals/consensus/index.js";
import { structureResolution } from "../signals/forecasting/structureResolution.js";
import { forecastProbability, getLastForecastTimeMs } from "../signals/forecasting/forecast.js";
import { runForecastGovernor, type ForecastCandidate } from "../signals/forecastGovernor.js";
import { combineSignals } from "../signals/combine.js";
import { selectCandidate, runRiskGate } from "../risk/gates.js";
import { executeTrade } from "../execution/paperTrade.js";
import { PaperPortfolio } from "../portfolio/paperPortfolio.js";
import { activity, layers } from "../config/index.js";
import { logDecision } from "../logging/index.js";
import { writeHeartbeat } from "./heartbeat.js";
import type { NormalizedMarket } from "../markets/types.js";
import type { ConsensusMatch } from "../signals/consensus/types.js";
import type { StructuredResolution } from "../signals/forecasting/types.js";

import { checkMove, recordActedReference, prioritizeQueue, type MoveCheck } from "../layers/latency/index.js";
import { classifyLongTail } from "../layers/longtail/index.js";
import { checkWithinMarketCoherence } from "../layers/coherence/withinMarket.js";
import { findRelatedPairs, detectJointIncoherence, toSubjectCandidate } from "../layers/coherence/acrossMarket.js";
import { planArbitragePair } from "../layers/coherence/arbitragePair.js";
import { realQuoteBuy as thinRealQuoteBuy } from "../execution/thinMarketFill.js";
import { getHerdingSignal, corroboratesFade, applyCorroborationBump } from "../layers/opponents/index.js";

export interface LayerLog {
  layerA?: { moved: boolean; reason: string };
  layerB?: { isLongTail: boolean; reason: string };
  layerC?: { withinMarketFlagged: boolean; drift: number | null };
  layerD?: { herdingDetected: boolean; corroborated: boolean; confidenceBump: number };
}

export interface MarketDecisionLog {
  market: NormalizedMarket;
  outcome: "traded" | "no-candidate" | "skipped";
  gate?: string;
  reason?: string;
  edge?: number;
  layers: LayerLog;
}

export interface CoherencePairLog {
  marketA: string;
  marketB: string;
  overlap: number;
  nearDuplicate: boolean;
  flagged: boolean;
  reason: string;
  arbitrageExecuted: boolean;
  arbitrageProfit: number | null;
}

/**
 * Cleanup pass: replaces the O(n^2) `moveChecks.find(m => m.market.address
 * === market.address)` (a linear scan repeated once per market in the main
 * decision loop) with a single O(n) map build + O(1) lookups — see
 * tests/paperLoop.test.ts for a test pinning this against the original
 * `.find()` semantics (first-match-wins on a duplicate address, though
 * market addresses are unique in practice).
 */
export function buildMoveByAddress(moveChecks: Array<{ market: { address: string }; move: MoveCheck }>): Map<string, MoveCheck> {
  const byAddress = new Map<string, MoveCheck>();
  for (const m of moveChecks) {
    if (!byAddress.has(m.market.address)) byAddress.set(m.market.address, m.move);
  }
  return byAddress;
}

export interface PaperPassResult {
  decisions: MarketDecisionLog[];
  coherencePairs: CoherencePairLog[];
  portfolio: PaperPortfolio;
  pricesByMarket: Map<string, number[]>;
  forecastGovernor: { candidateCount: number; forecastedCount: number; deferredCount: number };
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
  const fetchedMarkets = await fetchOpenMarkets({ limit: 50 });
  const pricesByMarket = new Map<string, number[]>();
  for (const m of fetchedMarkets) pricesByMarket.set(m.address, m.spotPrices ?? m.outcomes.map(() => NaN));

  // --- Pass 1: consensus (LLM-free) for every market ---
  const consensusByAddress = new Map<string, ConsensusMatch | null>();
  for (const market of fetchedMarkets) {
    const { match } = await findConsensusMatch(market);
    consensusByAddress.set(market.address, match);
    await writeHeartbeat(`consensus:${market.address}`).catch(() => {});
  }

  // --- Layer A: pure move-check reusing the consensus/price data above (no extra API calls), then reorder the queue ---
  const moveChecks = fetchedMarkets.map((market) => {
    const consensus = consensusByAddress.get(market.address) ?? null;
    const referenceProb = consensus?.outcomes[0]?.probability ?? null;
    const price = market.spotPrices?.[0] ?? NaN;
    const move = layers.aEnabled
      ? checkMove(market.address, referenceProb, price, layers.aReferenceMoveThreshold)
      : { moved: false, referenceDelta: null, priceDelta: null, reason: "Layer A disabled" };
    return { market, referenceProb, price, move };
  });
  const markets = layers.aEnabled ? prioritizeQueue(moveChecks) : fetchedMarkets;
  const moveByAddress = buildMoveByAddress(moveChecks);

  // --- Structuring (cached forever per market) for every market ---
  const structuredByAddress = new Map<string, StructuredResolution>();
  for (const market of markets) {
    structuredByAddress.set(market.address, await structureResolution(market));
    await writeHeartbeat(`structure:${market.address}`).catch(() => {});
  }

  // --- Layer B: classify long-tail (feeds F2 ranking below) ---
  const longTailByAddress = new Map<string, boolean>();
  for (const market of markets) {
    const result = await classifyLongTail(market, consensusByAddress.get(market.address) ?? null);
    longTailByAddress.set(market.address, result.isLongTail);
  }

  // --- F2: batch-rank and budget-govern forecasting for every no-consensus market ---
  const forecastCandidates: ForecastCandidate[] = markets
    .filter((m) => shouldRunForecast(consensusByAddress.get(m.address) ?? null))
    .map((market) => ({
      market,
      structured: structuredByAddress.get(market.address)!,
      longTail: longTailByAddress.get(market.address) ?? false,
      positionHeld: [...portfolio.positions.values()].some((p) => p.marketAddress === market.address),
      lastForecastAtMs: getLastForecastTimeMs(market.address),
    }));
  const governedOutcomes = await runForecastGovernor(forecastCandidates, forecastProbability, (marketAddress) => {
    void writeHeartbeat(`forecast:${marketAddress}`).catch(() => {});
  });
  const forecastByAddress = new Map(governedOutcomes.map((o) => [o.market.address, o]));

  // --- Layer C, within-market: log-only, reusing the Phase 1 epsilon check ---
  const withinMarketByAddress = new Map<string, ReturnType<typeof checkWithinMarketCoherence>>();
  if (layers.cEnabled) {
    for (const market of markets) {
      withinMarketByAddress.set(market.address, checkWithinMarketCoherence(market));
    }
  }

  // --- Main per-market pass: combine -> candidate -> Layer D -> risk gate -> execute/skip ---
  const decisions: MarketDecisionLog[] = [];

  for (const market of markets) {
    await writeHeartbeat(`decide:${market.address}`).catch(() => {});
    const consensus = consensusByAddress.get(market.address) ?? null;
    const governed = forecastByAddress.get(market.address);
    const forecast = governed?.result ?? null;
    const combined = combineSignals(market.spotPrices ?? market.outcomes.map(() => NaN), consensus, forecast);

    const withinMarket = withinMarketByAddress.get(market.address);
    const moveCheck = moveByAddress.get(market.address);

    const candidate = selectCandidate(market, combined);
    if (!candidate) {
      recordActedReference(market.address, consensus?.outcomes[0]?.probability ?? null, market.spotPrices?.[0] ?? NaN);
      decisions.push({
        market,
        outcome: "no-candidate",
        layers: {
          layerA: layers.aEnabled ? moveCheck : undefined,
          layerB: layers.bEnabled ? { isLongTail: longTailByAddress.get(market.address) ?? false, reason: "" } : undefined,
          layerC: withinMarket ? { withinMarketFlagged: withinMarket.flaggedForReview, drift: withinMarket.drift } : undefined,
        },
      });
      continue;
    }

    // --- Layer D: corroborating fade only, applied AFTER candidate selection ---
    let confidenceBump = 0;
    let herdingDetected = false;
    let corroborated = false;
    if (layers.dEnabled) {
      const herding = await getHerdingSignal(market.address);
      herdingDetected = herding.detected;
      corroborated = corroboratesFade(herding, candidate.outcomeIdx);
      const bumped = applyCorroborationBump(candidate.confidence, herding, candidate.outcomeIdx);
      confidenceBump = bumped - candidate.confidence;
      candidate.confidence = bumped;
    }

    const layerLog: LayerLog = {
      layerA: layers.aEnabled ? moveCheck : undefined,
      layerB: layers.bEnabled ? { isLongTail: longTailByAddress.get(market.address) ?? false, reason: "" } : undefined,
      layerC: withinMarket ? { withinMarketFlagged: withinMarket.flaggedForReview, drift: withinMarket.drift } : undefined,
      layerD: layers.dEnabled ? { herdingDetected, corroborated, confidenceBump } : undefined,
    };

    recordActedReference(market.address, consensus?.outcomes[0]?.probability ?? null, market.spotPrices?.[0] ?? NaN);

    const currentTotalExposureTokens = [...portfolio.positions.values()].reduce((sum, p) => sum + p.costBasis, 0);
    const structured = structuredByAddress.get(market.address)!;
    const gateResult = await runRiskGate(candidate, { structured, bankroll: portfolio.bankroll, currentTotalExposureTokens });

    if (gateResult.action === "skip") {
      decisions.push({ market, outcome: "skipped", gate: gateResult.skip.gate, reason: gateResult.skip.reason, edge: candidate.edge, layers: layerLog });
      continue;
    }

    if (!portfolio.canAfford(gateResult.trade.finalTokensIn)) {
      decisions.push({
        market,
        outcome: "skipped",
        gate: "sizing",
        reason: `insufficient paper bankroll (${portfolio.bankroll.toFixed(4)} TST < ${gateResult.trade.finalTokensIn.toFixed(4)} TST needed)`,
        edge: candidate.edge,
        layers: layerLog,
      });
      continue;
    }

    await executeTrade(gateResult.trade, portfolio);
    decisions.push({ market, outcome: "traded", edge: candidate.edge, layers: layerLog });
  }

  // --- Layer C, across-market: run once over the whole batch after structuring ---
  const coherencePairs: CoherencePairLog[] = [];
  if (layers.cEnabled) {
    const subjectCandidates = markets.map((m) => toSubjectCandidate(m, structuredByAddress.get(m.address)));
    const pairs = findRelatedPairs(subjectCandidates);
    for (const pair of pairs) {
      const incoherence = detectJointIncoherence(pair);
      let arbitrageExecuted = false;
      let arbitrageProfit: number | null = null;

      if (incoherence?.flagged) {
        const plan = await planArbitragePair(incoherence, 1, thinRealQuoteBuy);
        if (plan) {
          const now = new Date().toISOString();
          portfolio.recordBuy({
            timestamp: now,
            marketAddress: plan.cheapMarket.address,
            outcomeIdx: 0,
            question: plan.cheapMarket.question,
            shares: plan.shares,
            tokensIn: plan.costCheapLeg,
            effectivePrice: plan.costCheapLeg / plan.shares,
            slippagePct: plan.slippageCheapLeg,
            quotedPrice: plan.cheapMarket.spotPrices?.[0] ?? NaN,
            ourProbability: 1, // guaranteed by the complementary-pair structure, not a probability estimate
            edge: plan.profitPerShare,
          });
          portfolio.recordBuy({
            timestamp: now,
            marketAddress: plan.expensiveMarket.address,
            outcomeIdx: 1,
            question: plan.expensiveMarket.question,
            shares: plan.shares,
            tokensIn: plan.costExpensiveLeg,
            effectivePrice: plan.costExpensiveLeg / plan.shares,
            slippagePct: plan.slippageExpensiveLeg,
            quotedPrice: 1 - (plan.expensiveMarket.spotPrices?.[0] ?? NaN),
            ourProbability: 1,
            edge: plan.profitPerShare,
          });
          arbitrageExecuted = true;
          arbitrageProfit = plan.expectedProfit;
        }
      }

      coherencePairs.push({
        marketA: pair.a.market.address,
        marketB: pair.b.market.address,
        overlap: pair.overlap,
        nearDuplicate: pair.nearDuplicate,
        flagged: incoherence?.flagged ?? false,
        reason: incoherence?.reason ?? `related (overlap=${pair.overlap.toFixed(2)}, confidence=${pair.confidence}) — not a near-duplicate, no coherence expectation to check`,
        arbitrageExecuted,
        arbitrageProfit,
      });
    }
  }

  const distinctMarketsTraded = portfolio.distinctMarketsTraded();
  const tradeCount = portfolio.trades.length;

  // --- Structured logging (logging/): one line per decision. Trade fills log
  // themselves from execution/paperTrade.ts's single choke point, not here —
  // see that file's comment for why (so ad-hoc fills outside this loop, e.g.
  // scripts/paper-run.ts's synthetic demo, are never silently unlogged). ---
  await Promise.all(decisions.map((d) => logDecision(d).catch(() => {})));

  return {
    decisions,
    coherencePairs,
    portfolio,
    pricesByMarket,
    forecastGovernor: {
      candidateCount: forecastCandidates.length,
      forecastedCount: governedOutcomes.filter((o) => !o.deferred).length,
      deferredCount: governedOutcomes.filter((o) => o.deferred).length,
    },
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
