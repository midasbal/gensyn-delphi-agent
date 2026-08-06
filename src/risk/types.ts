import type { NormalizedMarket } from "../markets/types.js";
import type { MatchQuality } from "../signals/consensus/types.js";

export type GateName = "candidate" | "matchQuality" | "oracleAmbiguity" | "edgeThreshold" | "extremes" | "sizing" | "depthSlippage";

/** A market+outcome worth evaluating: the outcome with the largest POSITIVE edge on this market, if any. */
export interface TradeCandidate {
  market: NormalizedMarket;
  outcomeIdx: number;
  price: number;
  probability: number;
  confidence: number;
  edge: number;
  consensusMatchQuality: MatchQuality | null;
  hasForecast: boolean;
}

export interface SizedTrade extends TradeCandidate {
  /** Shares intended, pre-quote (human units, not the 18-decimal bigint). */
  desiredShares: number;
  /** Bankroll fraction implied by fractional Kelly, after all shrink factors. */
  kellyFraction: number;
  oracleAmbiguityScore: number;
  oracleAmbiguityRationale: string;
}

/** The final, post-quote, slippage-clipped trade — what execution/ actually books. */
export interface ClippedTrade extends SizedTrade {
  finalShares: number;
  finalTokensIn: number;
  effectivePrice: number;
  slippagePct: number;
}

export interface GateSkip {
  gate: GateName;
  reason: string;
}

export type GateDecision =
  | { action: "skip"; skip: GateSkip; market: NormalizedMarket }
  | { action: "trade"; trade: ClippedTrade };

export interface OracleAmbiguityScorer {
  /** 0 (crisp, low ambiguity) to 1 (vague, high ambiguity). */
  score(market: NormalizedMarket, structuredByLLM: boolean, sourceOfTruth: string | null, comparatorOrThreshold: string | null, condition: string): { score: number; rationale: string };
}
