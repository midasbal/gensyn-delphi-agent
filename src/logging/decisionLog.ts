/**
 * Structured decision log — one JSON line per market per pass. Deliberately
 * flattens MarketDecisionLog into a lean, self-contained record (question,
 * domain, price, edge, gate/reason, per-layer info, timestamp) rather than
 * the full NormalizedMarket blob — enough to reconstruct WHY every decision
 * was made without bloating a long-running VPS process's disk usage with
 * redundant on-chain metadata already available from the market address.
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
    layers: decision.layers,
  };
  await appendJsonLine("decisions", entry);
}
