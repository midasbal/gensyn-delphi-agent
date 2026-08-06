/**
 * Confidence-weighted fusion of a consensus match and a forecast into a
 * per-outcome combined probability, plus the resulting edge vs. each
 * outcome's live price. Generic over N outcomes — see signals/types.ts.
 *
 * matchQuality is a HARD gate here too, mirroring risk/gates.ts: a "high"
 * consensus match can dominate the blend; a "medium" one (e.g. the crypto
 * vol-model heuristic) is folded in at reduced weight for DISPLAY purposes,
 * but risk/gates.ts is what actually refuses to let a "medium"-only signal
 * justify a trade — this module just computes the number, it doesn't decide
 * tradability.
 */
import type { ConsensusMatch, MatchQuality } from "./consensus/types.js";
import type { ForecastResult } from "./forecasting/types.js";
import { estimatedCount, type OutcomeEstimate } from "./types.js";
import { signals as signalsConfig } from "../config/index.js";

export interface Contributor {
  source: string;
  probability: number;
  confidence: number;
  weight: number;
}

export interface CombinedOutcome {
  probability: number | null;
  confidence: number;
  /** probability - price. Null whenever probability is null. */
  edge: number | null;
  contributors: Contributor[];
}

export interface CombinedSignal {
  perOutcome: CombinedOutcome[];
  /** True if every outcome got a combined probability. */
  fullyEstimated: boolean;
  /** True if exactly one outcome has a combined probability — the case the project asks to flag explicitly. */
  singleOutcomeOnly: boolean;
  /** Null if there's no consensus match at all. */
  consensusMatchQuality: MatchQuality | null;
  note: string;
}

function consensusWeight(matchQuality: MatchQuality, hasForecast: boolean): number {
  if (matchQuality === "high") return hasForecast ? 0.85 : 1;
  return hasForecast ? 0.35 : 1; // "medium" — folded in at reduced weight for display, not trade-worthy alone
}

function combineOutcome(price: number, consensusEst: OutcomeEstimate | undefined, forecastEst: OutcomeEstimate | undefined, matchQuality: MatchQuality | null): CombinedOutcome {
  const hasConsensus = !!consensusEst && consensusEst.probability !== null;
  const hasForecast = !!forecastEst && forecastEst.probability !== null;
  const contributors: Contributor[] = [];

  if (!hasConsensus && !hasForecast) {
    return { probability: null, confidence: 0, edge: null, contributors };
  }

  let probability: number;
  let confidence: number;

  if (hasConsensus && hasForecast) {
    const cw = consensusWeight(matchQuality!, true);
    const fw = 1 - cw;
    contributors.push({ source: "consensus", probability: consensusEst!.probability!, confidence: consensusEst!.confidence, weight: cw });
    contributors.push({ source: "forecasting", probability: forecastEst!.probability!, confidence: forecastEst!.confidence, weight: fw });
    probability = cw * consensusEst!.probability! + fw * forecastEst!.probability!;
    confidence = cw * consensusEst!.confidence + fw * forecastEst!.confidence;
  } else if (hasConsensus) {
    contributors.push({ source: "consensus", probability: consensusEst!.probability!, confidence: consensusEst!.confidence, weight: 1 });
    probability = consensusEst!.probability!;
    confidence = consensusEst!.confidence;
  } else {
    // Forecast-only (no consensus backing at all on this outcome): cap the
    // confidence that flows into sizing at FORECAST_ONLY_MAX_WEIGHT,
    // regardless of what the model self-reports. There's no live-resolution
    // history yet to check this model's calibration against, so an
    // overconfident/uncalibrated forecast can't dominate a trade on its own
    // — see config/index.ts.
    const cappedConfidence = Math.min(forecastEst!.confidence, signalsConfig.forecastOnlyMaxWeight);
    contributors.push({ source: "forecasting", probability: forecastEst!.probability!, confidence: cappedConfidence, weight: 1 });
    probability = forecastEst!.probability!;
    confidence = cappedConfidence;
  }

  return { probability, confidence, edge: probability - price, contributors };
}

export function combineSignals(prices: number[], consensus: ConsensusMatch | null, forecast: ForecastResult | null): CombinedSignal {
  const perOutcome = prices.map((price, i) =>
    combineOutcome(price, consensus?.outcomes[i], forecast?.outcomes[i], consensus?.matchQuality ?? null)
  );

  const estimated = estimatedCount(perOutcome);
  const fullyEstimated = estimated === perOutcome.length;
  const singleOutcomeOnly = estimated === 1 && perOutcome.length > 1;

  const parts: string[] = [];
  perOutcome.forEach((o, i) => {
    if (o.probability !== null) parts.push(`[${i}]=${o.probability.toFixed(3)}`);
  });
  let note = parts.length > 0 ? parts.join(", ") : "no signal on any outcome";
  if (singleOutcomeOnly) note += " (FLAGGED: only one outcome could be estimated)";

  return {
    perOutcome,
    fullyEstimated,
    singleOutcomeOnly,
    consensusMatchQuality: consensus?.matchQuality ?? null,
    note,
  };
}
