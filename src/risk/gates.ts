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
import { resolveThinMarketFill } from "../execution/thinMarketFill.js";
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
  /** Cost basis already committed to THIS market (any outcomeIdx), 0 if not held. Bounds an add to a held market by what is left of the per-market cap, see gate (e). */
  currentMarketExposureTokens: number;
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
  let effectiveEdgeThreshold = riskConfig.edgeThreshold;
  if (inExtremeZone) {
    effectiveEdgeThreshold = riskConfig.edgeThreshold * riskConfig.extremeEdgeMultiplier;
    if (edge < effectiveEdgeThreshold) {
      return skipResult(
        market,
        "extremes",
        `price ${price.toFixed(4)} is within ${riskConfig.extremeZoneMargin} of 0/1; edge ${edge.toFixed(4)} < widened threshold ${effectiveEdgeThreshold.toFixed(4)}`
      );
    }
    extremeSizeShrink = riskConfig.extremeSizeMultiplier;
  }

  // (e) Sizing: conservative fractional Kelly, scaled by confidence and shrink
  // factors, capped by a per-market absolute, the REMAINING per-market
  // fraction of live account value, and a total fraction of live account
  // value.
  //
  // Account value (accountValueTokens) is bankroll plus current total cost
  // basis, both already passed in ctx, in the same TST unit as
  // currentTotalExposureTokens. Both exposure caps scale with this instead
  // of being a flat absolute, so a growing (or shrinking) account moves the
  // caps with it, and a single bet can never permanently saturate the total
  // cap the way a flat MAX_TOTAL_EXPOSURE_TOKENS could.
  //
  // perMarketRemaining subtracts ctx.currentMarketExposureTokens (0 if this
  // market is not currently held) from the per-market cap, so an add to a
  // held market is bounded by what is left of that market's own cap, not
  // by the flat per-market cap itself. A fresh entry (currentMarketExposureTokens
  // is 0) sees the full per-market cap, same as before. This is what lets
  // loop/paperLoop.ts's over-re-entry guard allow an add up to the cap
  // instead of blocking every add outright: cumulative per-market exposure
  // still can never exceed the cap, so unbounded re-entry stays impossible.
  const isAdd = ctx.currentMarketExposureTokens > 0;
  const ambiguityShrink = 1 - ambiguity.score;
  const kellyFraction = conservativeKellyFraction(edge, price, riskConfig.kellyFraction, confidence, [ambiguityShrink, extremeSizeShrink]);
  const kellyDesiredTokens = kellyFraction * ctx.bankroll;

  const accountValueTokens = ctx.bankroll + ctx.currentTotalExposureTokens;
  const maxTotalExposureTokens = riskConfig.maxTotalExposureFraction * accountValueTokens;
  const remainingExposureBudget = Math.max(0, maxTotalExposureTokens - ctx.currentTotalExposureTokens);
  const perMarketRemaining = Math.max(0, riskConfig.maxPerMarketExposureFraction * accountValueTokens - ctx.currentMarketExposureTokens);

  // Track which cap actually binds, for the skip reason below (requirement:
  // report which bound caused the skip, not just the final number).
  const sizeCandidates: Array<{ label: string; value: number }> = [
    { label: "kelly", value: kellyDesiredTokens },
    { label: "maxPositionTokens", value: riskConfig.maxPositionTokens },
    { label: "remainingExposureBudget", value: remainingExposureBudget },
    { label: "perMarketRemaining", value: perMarketRemaining },
  ];
  let desiredTokens = sizeCandidates[0]!.value;
  let bindingConstraint = sizeCandidates[0]!.label;
  for (const candidate of sizeCandidates.slice(1)) {
    if (candidate.value < desiredTokens) {
      desiredTokens = candidate.value;
      bindingConstraint = candidate.label;
    }
  }

  // F1 (thinMarketFillsEnabled): the dust-threshold floor is a SOFT policy
  // minimum this rule is explicitly allowed to fill below, enforcement
  // moves to gate f's hardMinShares check instead. Phase 3 default
  // (disabled): unchanged hard skip here.
  if (!riskConfig.thinMarketFillsEnabled && desiredTokens < riskConfig.dustThresholdTokens) {
    return skipResult(
      market,
      "sizing",
      `sized ${isAdd ? "add" : "entry"} ${desiredTokens.toFixed(4)} TST is below dust threshold ${riskConfig.dustThresholdTokens} after Kelly/caps (kellyFraction=${kellyFraction.toFixed(4)}, boundBy=${bindingConstraint}, remainingExposureBudget=${remainingExposureBudget.toFixed(2)}, perMarketRemaining=${perMarketRemaining.toFixed(2)}, currentMarketExposureTokens=${ctx.currentMarketExposureTokens.toFixed(2)})`
    );
  }
  if (desiredTokens <= 0) {
    return skipResult(
      market,
      "sizing",
      `sized ${isAdd ? "add" : "entry"} is ${desiredTokens.toFixed(4)} TST, nothing to size (boundBy=${bindingConstraint}, remainingExposureBudget=${remainingExposureBudget.toFixed(2)}, perMarketRemaining=${perMarketRemaining.toFixed(2)}, currentMarketExposureTokens=${ctx.currentMarketExposureTokens.toFixed(2)})`
    );
  }

  const desiredShares = desiredTokens / price;

  // (f) Depth/slippage clip — quote the intended size first, always.
  if (riskConfig.thinMarketFillsEnabled) {
    const softMinShares = riskConfig.dustThresholdTokens / price;
    const thin = await resolveThinMarketFill(
      market.address,
      outcomeIdx,
      desiredShares,
      price,
      probability,
      effectiveEdgeThreshold,
      riskConfig.slippageTolerance,
      riskConfig.hardMinShares,
      softMinShares
    );
    if (!thin) {
      return skipResult(
        market,
        "depthSlippage",
        `no size >= hardMinShares (${riskConfig.hardMinShares}) both fit slippage tolerance (${riskConfig.slippageTolerance}) and cleared the edge threshold (${effectiveEdgeThreshold.toFixed(4)}) at its actual fill price`
      );
    }
    return {
      action: "trade",
      trade: {
        ...candidate,
        desiredShares,
        kellyFraction,
        oracleAmbiguityScore: ambiguity.score,
        oracleAmbiguityRationale: ambiguity.rationale,
        finalShares: thin.finalShares,
        finalTokensIn: thin.finalTokensIn,
        effectivePrice: thin.effectivePrice,
        slippagePct: thin.slippagePct,
      },
    };
  }

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
