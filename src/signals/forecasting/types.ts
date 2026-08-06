import type { OutcomeEstimate } from "../types.js";

export interface StructuredResolution {
  subject: string;
  condition: string;
  comparatorOrThreshold: string | null;
  sourceOfTruth: string | null;
  /** ISO timestamp string. Always derived from the market's structured resolvesAt, not parsed from text. */
  resolutionTime: string | null;
  /** True if an LLM actually produced this; false means it's a degraded fallback built directly from Phase 1's ParsedResolution (no regex re-parsing — see structureResolution.ts). */
  structuredByLLM: boolean;
}

export interface ForecastResult {
  /** One entry per market.outcomes[i], same order/length — see signals/types.ts. */
  outcomes: OutcomeEstimate[];
  rationale: string;
  sourcesUsed: string[];
  /** Reference-class base rate the model started from, before case-specific adjustment. */
  baseRate?: number;
  keyDrivers?: string[];
  resolutionRisk?: string;
  evidenceQuality?: "strong" | "moderate" | "thin" | "none";
}
