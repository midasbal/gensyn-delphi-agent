/**
 * The gate every trade candidate passes, IN ORDER. Each step can only skip
 * or narrow — nothing here ever increases size or relaxes an earlier
 * decision. See risk/types.ts for the shapes and PROJECT docs (RULES.md,
 * once written) for why each gate exists.
 */
import type { NormalizedMarket } from "../markets/types.js";
import type { CombinedSignal } from "../signals/combine.js";
import type { StructuredResolution } from "../signals/forecasting/types.js";
import { risk as riskConfig } from "../config/index.js";
import { heuristicOracleAmbiguityScorer } from "./oracleAmbiguity.js";
import { conservativeKellyFraction } from "./kelly.js";
import { quoteWithSlippageClip } from "../execution/quote.js";
import type { GateDecision, TradeCandidate } from "./types.js";

function skipResult(market: NormalizedMarket, gate: "candidate" | "matchQuality" | "oracleAmbiguity" | "edgeThreshold" | "extremes" | "sizing" | "depthSlippage", reason: string): GateDecision {
  return { action: "skip", skip: { gate, reason }, market };
}

/**
 * Picks the outcome with the largest POSITIVE edge (our probability > price)
 * as this market's buy candidate — the Kelly formula this pipeline uses is
 * specifically for buying, so a negative edge on an outcome isn't actionable
 * without an existing position to sell against (that's the redeem/liquidate
 * exit path, not entry sizing). Returns null if no outcome has any signal or
 * every signalled outcome is priced correctly-or-better already.
 */
export function selectCandidate(market: NormalizedMarket, combined: CombinedSignal): TradeCandidate | null {
  let best: TradeCandidate | null = null;

  combined.perOutcome.forEach((outcome, i) => {
    if (outcome.probability === null || outcome.edge === null) return;
    if (outcome.edge <= 0) return;
    const price = market.spotPrices?.[i];
    if (price === undefined) return;
    if (!best || outcome.edge > best.edge) {
      best = {
        market,
        outcomeIdx: i,
        price,
        probability: outcome.probability,
        confidence: outcome.confidence,
        edge: outcome.edge,
        consensusMatchQuality: combined.consensusMatchQuality,
        hasForecast: outcome.contributors.some((c) => c.source === "forecasting"),
      };
    }
  });

  return best;
}

export interface GateContext {
  structured: StructuredResolution;
  bankroll: number;
  currentTotalExposureTokens: number;
}

export async function runRiskGate(candidate: TradeCandidate, ctx: GateContext): Promise<GateDecision> {
  const { market, outcomeIdx, price, probability, confidence, edge, consensusMatchQuality, hasForecast } = candidate;

  // (a) Confidence + matchQuality gate — matchQuality is a HARD gate: a
  // consensus match that isn't "high" quality cannot alone justify a trade;
  // it needs independent forecast backing (see signals/consensus/index.ts
  // shouldRunForecast, which is why a "medium" consensus still runs forecasting).
  if (confidence < riskConfig.minConfidence) {
    return skipResult(market, "matchQuality", `confidence ${confidence.toFixed(2)} < minimum ${riskConfig.minConfidence}`);
  }
  if (consensusMatchQuality !== "high" && !hasForecast) {
    return skipResult(
      market,
      "matchQuality",
      `no HIGH-quality consensus match (got: ${consensusMatchQuality ?? "none"}) and no forecast to independently back the estimate`
    );
  }

  // (b) Oracle-ambiguity filter — heuristic placeholder, see oracleAmbiguity.ts.
  const ambiguity = heuristicOracleAmbiguityScorer.score(
    market,
    ctx.structured.structuredByLLM,
    ctx.structured.sourceOfTruth,
    ctx.structured.comparatorOrThreshold,
    ctx.structured.condition
  );
  if (ambiguity.score > riskConfig.oracleAmbiguitySkipThreshold) {
    return skipResult(market, "oracleAmbiguity", `ambiguity ${ambiguity.score.toFixed(2)} > skip threshold ${riskConfig.oracleAmbiguitySkipThreshold}: ${ambiguity.rationale}`);
  }

  // (c) Edge threshold.
  if (Math.abs(edge) < riskConfig.edgeThreshold) {
    return skipResult(market, "edgeThreshold", `|edge| ${Math.abs(edge).toFixed(4)} < minimum ${riskConfig.edgeThreshold}`);
  }

  // (d) Extremes caution — widen the required edge and shrink size near price 0/1.
  const inExtremeZone = price < riskConfig.extremeZoneMargin || price > 1 - riskConfig.extremeZoneMargin;
  let extremeSizeShrink = 1;
  if (inExtremeZone) {
    const widenedThreshold = riskConfig.edgeThreshold * riskConfig.extremeEdgeMultiplier;
    if (edge < widenedThreshold) {
      return skipResult(
        market,
        "extremes",
        `price ${price.toFixed(4)} is within ${riskConfig.extremeZoneMargin} of 0/1; edge ${edge.toFixed(4)} < widened threshold ${widenedThreshold.toFixed(4)}`
      );
    }
    extremeSizeShrink = riskConfig.extremeSizeMultiplier;
  }

  // (e) Sizing — conservative fractional Kelly, scaled by confidence and shrink factors, capped both per-market and total.
  const ambiguityShrink = 1 - ambiguity.score;
  const kellyFraction = conservativeKellyFraction(edge, price, riskConfig.kellyFraction, confidence, [ambiguityShrink, extremeSizeShrink]);
  let desiredTokens = kellyFraction * ctx.bankroll;
  desiredTokens = Math.min(desiredTokens, riskConfig.maxPositionTokens);
  const remainingExposureBudget = Math.max(0, riskConfig.maxTotalExposureTokens - ctx.currentTotalExposureTokens);
  desiredTokens = Math.min(desiredTokens, remainingExposureBudget);

  if (desiredTokens < riskConfig.dustThresholdTokens) {
    return skipResult(
      market,
      "sizing",
      `sized position ${desiredTokens.toFixed(4)} TST is below dust threshold ${riskConfig.dustThresholdTokens} after Kelly/caps (kellyFraction=${kellyFraction.toFixed(4)}, remainingExposureBudget=${remainingExposureBudget.toFixed(2)})`
    );
  }

  const desiredShares = desiredTokens / price;

  // (f) Depth/slippage clip — quote the intended size first, always.
  const clip = await quoteWithSlippageClip(market.address, outcomeIdx, desiredShares, price);
  if (!clip) {
    return skipResult(market, "depthSlippage", `quote reverted or slippage exceeded tolerance (${riskConfig.defaultSlippageBps}bps) even after halving down to the minimum size floor`);
  }
  if (clip.finalTokensIn < riskConfig.dustThresholdTokens) {
    return skipResult(market, "depthSlippage", `slippage-clipped size (${clip.finalShares.toFixed(4)} shares, ${clip.finalTokensIn.toFixed(4)} TST) rounds to dust`);
  }

  return {
    action: "trade",
    trade: {
      ...candidate,
      desiredShares,
      kellyFraction,
      oracleAmbiguityScore: ambiguity.score,
      oracleAmbiguityRationale: ambiguity.rationale,
      finalShares: clip.finalShares,
      finalTokensIn: clip.finalTokensIn,
      effectivePrice: clip.effectivePrice,
      slippagePct: clip.slippagePct,
    },
  };
}
