import type { NormalizedMarket } from "../../markets/types.js";
import type { ConsensusAdapter, ConsensusMatch } from "./types.js";
import { polymarketAdapter } from "./polymarket.js";
import { sportsOddsAdapter } from "./sportsOdds.js";
import { cryptoAdapter } from "./crypto.js";

// Priority order per the project brief: Polymarket is the broad-coverage
// backbone tried first for every market; sports/crypto are domain-specific
// and only apply when relevant.
export const CONSENSUS_ADAPTERS: ConsensusAdapter[] = [polymarketAdapter, sportsOddsAdapter, cryptoAdapter];

export interface ConsensusAttempt {
  adapterName: string;
  configured: boolean;
  result: ConsensusMatch | null;
}

export interface ConsensusOutcome {
  match: ConsensusMatch | null;
  attempts: ConsensusAttempt[];
}

/**
 * Tries every configured adapter in priority order. Stops early and returns
 * immediately on the first "high" quality match (the hard-gated, trade-
 * worthy kind — see consensus/types.ts). If no "high" match is found after
 * trying all adapters, falls back to the first "medium" match seen (if any)
 * — useful for the combined-signal DISPLAY, but callers must remember a
 * "medium" match here does not by itself justify a trade (risk/gates.ts
 * enforces that) and should still run forecasting rather than treat this as
 * a confident answer — see shouldRunForecast().
 */
export async function findConsensusMatch(market: NormalizedMarket): Promise<ConsensusOutcome> {
  const attempts: ConsensusAttempt[] = [];
  let mediumFallback: ConsensusMatch | null = null;

  for (const adapter of CONSENSUS_ADAPTERS) {
    const configured = adapter.isConfigured();
    if (!configured) {
      attempts.push({ adapterName: adapter.name, configured: false, result: null });
      continue;
    }

    let result: ConsensusMatch | null;
    try {
      result = await adapter.match(market);
    } catch {
      // Adapters are documented to never throw, but the router does not
      // trust that promise blindly — a bug in one adapter must not take
      // down the pipeline for every market that follows it.
      result = null;
    }
    attempts.push({ adapterName: adapter.name, configured: true, result });

    if (result) {
      if (result.matchQuality === "high") {
        return { match: result, attempts };
      }
      mediumFallback ??= result;
    }
  }

  return { match: mediumFallback, attempts };
}

/** A non-"high" (or absent) consensus match must not block forecasting — only "high" is trade-worthy on its own. */
export function shouldRunForecast(consensus: ConsensusMatch | null): boolean {
  return !consensus || consensus.matchQuality !== "high";
}

export * from "./types.js";
