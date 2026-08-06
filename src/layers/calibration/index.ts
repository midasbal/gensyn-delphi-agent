/**
 * Layer F, wave 2 — calibration tracking + endgame variance management.
 * WAVE 2 (post-Aug-10 live data). Interface/stub only — no implementation,
 * no fabricated tuning curve. Wave 1 (this phase) ships F1 (thin-market
 * fills — risk/gates.ts + execution/thinMarketFill.ts) and F2 (forecast
 * token-budget governor — signals/forecastGovernor.ts); this file is where
 * wave 2's two remaining pieces will plug in once there's real resolution
 * data and a real leaderboard position to react to.
 *
 * 1. Calibration: log predicted probability vs realized outcome (consumes
 *    layers/oracle's ResolutionLogEntry — same underlying data, different
 *    use: Layer E asks "how ambiguous was this resolution", calibration
 *    asks "was our stated confidence trustworthy"). Once there's a
 *    meaningful sample, this recalibrates two things without any code
 *    changes elsewhere: signals/combine.ts's consensusWeight()/
 *    FORECAST_ONLY_MAX_WEIGHT (per-source reliability) and a per-market-
 *    domain skill multiplier (e.g. "our sports forecasts run 10 points
 *    overconfident, our economics forecasts are well-calibrated").
 *
 * 2. Endgame: as the competition's two-week window closes, sizing should
 *    react to current leaderboard standing — e.g. tighten risk if
 *    comfortably ahead, or accept more variance if behind and running out
 *    of time to close the gap. That needs the actual leaderboard API/feed,
 *    which nothing in this codebase reads yet.
 *
 * Both stay unimplemented on purpose: fitting a calibration curve or an
 * endgame variance target from zero real resolutions/leaderboard reads
 * would be fabricated, not calibrated.
 */
import type { OutcomeEstimate } from "../../signals/types.js";

export interface CalibrationRecord {
  marketAddress: string;
  source: "consensus" | "forecasting";
  predictedProbability: number;
  predictedConfidence: number;
  actualOutcome: boolean; // did the specific outcome this prediction was for actually win
  resolvedAt: string;
}

/** Interface a wave-2 implementation will satisfy — not implemented here. */
export interface CalibrationModel {
  /** Recalibrated confidence/weight for a given source+domain, given the accumulated CalibrationRecord history. Wave 1: not implemented. */
  adjustedWeight(source: "consensus" | "forecasting", domain: string, rawEstimate: OutcomeEstimate): number;
}

export interface LeaderboardStanding {
  rank: number;
  totalAgents: number;
  accountValue: number;
  leaderAccountValue: number;
}

/** Interface a wave-2 implementation will satisfy — not implemented here. */
export interface EndgameStrategy {
  /** Adjusts the Kelly multiplier (risk.kellyFraction) based on time-remaining and leaderboard standing. Wave 1: not implemented — risk/kelly.ts uses the static configured fraction only. */
  adjustedKellyMultiplier(standing: LeaderboardStanding, timeRemainingMs: number): number;
}
