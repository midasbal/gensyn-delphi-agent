/**
 * Gate (b): oracle-ambiguity filter. HEURISTIC placeholder — this scores
 * ambiguity from the structured resolution's crispness (is there a stated
 * source of truth? a stated threshold? was it actually LLM-structured, or is
 * this the degraded Phase 1 fallback?). It has no data on how the
 * competition's actual AI oracle behaves.
 *
 * Phase 4 Layer E is the intended replacement: it will log every real
 * resolution (source, wording, timing) and learn an EMPIRICAL per-market
 * ambiguity score from that history. This file exists so that swap is a
 * drop-in — anything implementing OracleAmbiguityScorer (risk/types.ts) can
 * replace heuristicOracleAmbiguityScorer in risk/gates.ts with no other
 * change required.
 */
import type { NormalizedMarket } from "../markets/types.js";
import type { OracleAmbiguityScorer } from "./types.js";

export const heuristicOracleAmbiguityScorer: OracleAmbiguityScorer = {
  score(_market: NormalizedMarket, structuredByLLM: boolean, sourceOfTruth: string | null, comparatorOrThreshold: string | null, condition: string) {
    let score = 0;
    const reasons: string[] = [];

    if (!sourceOfTruth) {
      score += 0.4;
      reasons.push("no stated source of truth (+0.4)");
    }
    if (!comparatorOrThreshold) {
      score += 0.25;
      reasons.push("no stated threshold/comparator — likely a judgment call, not a number (+0.25)");
    }
    if (!condition || condition.trim().length < 8) {
      score += 0.15;
      reasons.push("condition is empty/too short to be a crisp criterion (+0.15)");
    }
    if (!structuredByLLM) {
      score += 0.2;
      reasons.push("resolution was never actually structured by an LLM (degraded Phase 1 fallback) — low confidence in the above (+0.2)");
    }

    const clamped = Math.min(1, score);
    return { score: clamped, rationale: reasons.length > 0 ? reasons.join("; ") : "resolution looks crisp: stated source, threshold, and condition" };
  },
};
