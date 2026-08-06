import type { NormalizedMarket } from "../../markets/types.js";
import type { OutcomeEstimate, MatchQuality } from "../types.js";

export type { MatchQuality };

export interface ConsensusMatch {
  /** One entry per market.outcomes[i], same order/length — see signals/types.ts. */
  outcomes: OutcomeEstimate[];
  sourceName: string;
  /**
   * HARD gate, not a descriptive label (see risk/gates.ts). "high" means the
   * adapter verified subject + threshold/condition + timing all correspond
   * to THIS market before returning anything — a mismatch on any of those
   * forces null, never a lower-quality partial credit. "medium" is reserved
   * for sources that are legitimately lower-certainty by construction (e.g.
   * the crypto vol-model heuristic, which is a computed proxy, not a matched
   * external market) — a "medium" match can still inform the combined
   * signal for display, but risk/gates.ts never lets it alone justify a
   * trade the way a "high" match can.
   */
  matchQuality: MatchQuality;
  /** Human-readable explanation of what was matched and why — for logs/debugging. */
  detail: string;
  sourceUrl?: string;
}

export interface ConsensusAdapter {
  name: string;
  /** False if the adapter is missing required config (e.g. an API key). Never throws. */
  isConfigured(): boolean;
  /**
   * Attempt to find a matching external reference for this market. Returns
   * null on no confident match, missing config, irrelevant domain, or ANY
   * error (network, parsing, timeout) — this method must never throw or
   * crash the pipeline. A "high" quality match must have subject, threshold/
   * condition, and timing all verified to correspond to this market — see
   * matchQuality doc above.
   */
  match(market: NormalizedMarket): Promise<ConsensusMatch | null>;
}
