/**
 * F2 — ranks markets needing a forecast and only calls the LLM for as many
 * as the rolling 24h token budget (tokenBudget.ts) allows; the rest are
 * deferred, not silently dropped. This is what makes "rank by proximity to
 * resolution, edge potential, position held, staleness" and "when budget is
 * tight, forecast the top ones" real instead of aspirational — a plain
 * per-market loop can't defer, only a batch-level governor over the whole
 * candidate list can.
 *
 * NEVER touches consensus (signals/consensus/) or Layer A (layers/latency/)
 * — both are structurally separate, LLM-free code paths that this module
 * doesn't call into at all, so there's nothing here that could block them.
 */
import type { NormalizedMarket } from "../markets/types.js";
import type { StructuredResolution, ForecastResult } from "./forecasting/types.js";
import { forecastProbability } from "./forecasting/forecast.js";
import { hasBudgetFor } from "./forecasting/tokenBudget.js";
import { forecastBudget } from "../config/index.js";

// Calibrated against a real live Groq forecast call this phase: measured
// usage.total_tokens was 863 for one forecastProbability() call against a
// live competition market (llama-3.3-70b-versatile, this project's actual
// system+user prompt). Rounded up to 900 so the governor is conservative
// about how many calls it thinks it can afford, not optimistic.
export const ESTIMATED_TOKENS_PER_FORECAST = 900;

export interface ForecastCandidate {
  market: NormalizedMarket;
  structured: StructuredResolution;
  /** Layer B's classification — long-tail markets get forecast priority, per the project brief. */
  longTail: boolean;
  positionHeld: boolean;
  /** Null = never forecast yet (highest staleness priority). */
  lastForecastAtMs: number | null;
}

export interface RankedCandidate extends ForecastCandidate {
  score: number;
  breakdown: string;
}

const PROXIMITY_HORIZON_DAYS = 14; // roughly the competition window — anything further out ranks low on urgency

function proximityScore(market: NormalizedMarket, nowMs: number): number {
  if (!market.resolvesAt) return 0;
  const daysUntil = (market.resolvesAt.getTime() - nowMs) / 86_400_000;
  if (daysUntil <= 0) return 1; // already due/overdue — max urgency
  return Math.max(0, 1 - daysUntil / PROXIMITY_HORIZON_DAYS);
}

function stalenessScore(lastForecastAtMs: number | null, nowMs: number): number {
  if (lastForecastAtMs === null) return 1; // never forecast — max priority
  const minutesSince = (nowMs - lastForecastAtMs) / 60_000;
  return Math.min(1, minutesSince / forecastBudget.forecastStalenessMinutes);
}

/** Pure — no I/O, unit-testable. */
export function rankForecastCandidates(candidates: ForecastCandidate[], nowMs: number = Date.now()): RankedCandidate[] {
  const ranked = candidates.map((c) => {
    const proximity = proximityScore(c.market, nowMs);
    const edgePotential = c.longTail ? 1 : 0.3; // long-tail = least priced-in = fattest potential edge, per the project brief
    const held = c.positionHeld ? 1 : 0;
    const staleness = stalenessScore(c.lastForecastAtMs, nowMs);

    const score = 0.3 * proximity + 0.3 * edgePotential + 0.2 * held + 0.2 * staleness;
    return {
      ...c,
      score,
      breakdown: `proximity=${proximity.toFixed(2)} edgePotential=${edgePotential.toFixed(2)} held=${held} staleness=${staleness.toFixed(2)}`,
    };
  });
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

export interface GovernedForecastOutcome {
  market: NormalizedMarket;
  result: ForecastResult | null;
  deferred: boolean;
}

/**
 * Ranks candidates and forecasts them in priority order until the token
 * budget runs out; remaining candidates are returned with deferred=true and
 * result=null — never called, never guessed. `forecastFn` is injected for
 * testability (default: the real forecastProbability).
 */
export async function runForecastGovernor(
  candidates: ForecastCandidate[],
  forecastFn: (market: NormalizedMarket, structured: StructuredResolution) => Promise<ForecastResult | null> = forecastProbability
): Promise<GovernedForecastOutcome[]> {
  const ranked = rankForecastCandidates(candidates);
  const outcomes: GovernedForecastOutcome[] = [];

  for (const candidate of ranked) {
    if (!hasBudgetFor(ESTIMATED_TOKENS_PER_FORECAST)) {
      outcomes.push({ market: candidate.market, result: null, deferred: true });
      continue;
    }
    const result = await forecastFn(candidate.market, candidate.structured);
    outcomes.push({ market: candidate.market, result, deferred: false });
  }

  return outcomes;
}
