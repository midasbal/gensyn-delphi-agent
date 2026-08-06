/**
 * Layer E — empirical oracle-ambiguity calibration. WAVE 2 (post-Aug-10 live
 * data). This file is an interface/stub only — it does NOT implement a
 * scorer, and does not fabricate any behavior from data that doesn't exist
 * yet.
 *
 * The swap point already exists from Phase 3: risk/types.ts's
 * `OracleAmbiguityScorer` interface (`score(market, structuredByLLM,
 * sourceOfTruth, comparatorOrThreshold, condition) -> {score, rationale}`)
 * is what risk/gates.ts calls at gate (b). Today it's wired to
 * risk/oracleAmbiguity.ts's `heuristicOracleAmbiguityScorer` — a fixed
 * rule-of-thumb (no stated source/threshold/condition raises the score).
 * Layer E's job, once there is a real history of HOW markets actually
 * resolved (which source was cited, how wording ambiguity played out,
 * whether the stated resolutionTime was honored), is to implement the SAME
 * interface empirically — e.g. a model trained or fit on resolved markets'
 * actual ambiguity outcomes — and swap it in at risk/gates.ts's one call
 * site. No other code changes required.
 *
 * What IS built now: the data-collection stub every resolution should feed,
 * so the log exists by the time there's enough of it to fit anything to.
 * recordResolution() is deliberately a no-op beyond an in-memory list this
 * phase — Phase 5's persistent structured logging (logging/) is what turns
 * this into a durable, cross-run dataset. Wiring the actual call site
 * (execution/settlementSweep.ts, when a redeem/liquidate fires) is also
 * deferred to wave 2, since there's nothing to record yet: none of the 10
 * live competition markets have resolved as of this phase.
 */
import type { NormalizedMarket } from "../../markets/types.js";
import type { StructuredResolution } from "../../signals/forecasting/types.js";

export interface ResolutionLogEntry {
  marketAddress: string;
  question: string;
  structuredResolution: StructuredResolution;
  /** What we predicted before resolution (combined signal probability for the winning-or-not outcome), if we had one. */
  predictedProbability: number | null;
  winningOutcomeIdx: number | null;
  resolvedAt: string;
  /** True if the market resolved to "failed" (oracle could not resolve) — itself a data point about ambiguity. */
  oracleFailed: boolean;
}

// Process-lifetime only, same caveat as layers/latency's lastActed map —
// Phase 5's persistent logging is what makes this durable across runs.
const resolutionLog: ResolutionLogEntry[] = [];

export function recordResolution(entry: ResolutionLogEntry): void {
  resolutionLog.push(entry);
}

export function getResolutionLog(): readonly ResolutionLogEntry[] {
  return resolutionLog;
}
