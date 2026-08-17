/**
 * Structured decision log — one JSON line per market per pass. Deliberately
 * flattens MarketDecisionLog into a lean, self-contained record (question,
 * domain, price, edge, gate/reason, per-layer info, timestamp) rather than
 * the full NormalizedMarket blob — enough to reconstruct WHY every decision
 * was made without bloating a long-running VPS process's disk usage with
 * redundant on-chain metadata already available from the market address.
 *
 * ourProbability/marketPrice/confidence/positionHeld/action are edge
 * instrumentation: additive fields for calibrating the edge threshold from
 * real data, not inputs to any decision. `gate` (when the outcome is
 * "skipped") already names which risk-gate step caused the skip
 * (edgeThreshold, matchQuality covers the confidence check,
 * oracleAmbiguity, extremes, depthSlippage, sizing, rawEdgeTooLarge, or
 * this loop's own alreadyHeld/atPerMarketCap).
 *
 * adjustedProbability/adjustedEdge are the market-shrink calibration fix:
 * ourProbability/edge above stay RAW (unchanged meaning), these are the
 * shrunk values risk/gates.ts's shrinkTowardMarket() computed (or would
 * have computed) for this decision. Compare raw vs adjusted directly to
 * measure the fix over time: smaller adjusted edges, fewer
 * rawEdgeTooLarge skips as the model's raw calibration improves, adjusted
 * edges clustering near the market price.
 */
import { appendJsonLine } from "./writer.js";
import type { MarketDecisionLog } from "../loop/paperLoop.js";

export interface DecisionLogEntry {
  timestamp: string;
  marketAddress: string;
  question: string;
  domain: string;
  status: string;
  price0: number | null;
  outcome: "traded" | "no-candidate" | "skipped";
  gate?: string;
  reason?: string;
  edge?: number;
  ourProbability?: number;
  marketPrice?: number;
  confidence?: number;
  positionHeld: boolean;
  action: "buy" | "add" | "skip" | "hold" | "exit";
  adjustedProbability?: number;
  adjustedEdge?: number;
  layers: MarketDecisionLog["layers"];
}

export async function logDecision(decision: MarketDecisionLog): Promise<void> {
  const entry: DecisionLogEntry = {
    timestamp: new Date().toISOString(),
    marketAddress: decision.market.address,
    question: decision.market.question,
    domain: decision.market.domain,
    status: decision.market.status,
    price0: decision.market.spotPrices?.[0] ?? null,
    outcome: decision.outcome,
    gate: decision.gate,
    reason: decision.reason,
    edge: decision.edge,
    ourProbability: decision.ourProbability,
    marketPrice: decision.marketPrice,
    confidence: decision.confidence,
    positionHeld: decision.positionHeld,
    action: decision.action,
    adjustedProbability: decision.adjustedProbability,
    adjustedEdge: decision.adjustedEdge,
    layers: decision.layers,
  };
  await appendJsonLine("decisions", entry);
}
