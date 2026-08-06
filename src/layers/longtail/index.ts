/**
 * Layer B — long-tail routing.
 *
 * A market is "long-tail" when it has BOTH no confident (high-quality)
 * consensus reference AND thin subgraph trade history — i.e. nobody has
 * traded it much yet and there's no external reference to lean on. This is
 * exactly where the project brief says edge is fattest, because it's where
 * the least information has already been priced in.
 *
 * This layer only classifies — it never trades. The flag feeds two other
 * places: F2's forecast-budget ranking (long-tail markets get priority for
 * deeper LLM research) and, in the future, a deeper-evidence-retrieval path
 * for forecasting itself (not built yet — no live long-tail market has
 * needed it; see the Phase 4 checkpoint report for why).
 *
 * THIN_TRADE_COUNT_THRESHOLD is an internal constant, not an env var — the
 * project brief only asks for a B_ENABLED flag for this layer, so the
 * threshold stays a documented in-code default rather than growing the env
 * surface for a single-layer tuning knob nobody asked to expose.
 */
import type { NormalizedMarket } from "../../markets/types.js";
import type { ConsensusMatch } from "../../signals/consensus/types.js";
import { getSubgraph } from "../../sdk/client.js";
import { layers } from "../../config/index.js";

export const THIN_TRADE_COUNT_THRESHOLD = 10;
const SUBGRAPH_SAMPLE_SIZE = 25; // enough to distinguish "thin" from "active" without over-fetching

export interface LongTailResult {
  isLongTail: boolean;
  reason: string;
  tradeCount: number | null; // null if the subgraph query failed — treated as "unknown", not "thin"
}

/** Counts buys+sells for a market via the subgraph. Never throws — a query failure returns null (unknown), not zero. */
async function countSubgraphTrades(marketAddress: string): Promise<number | null> {
  try {
    const subgraph = getSubgraph();
    const { buys, sells } = await subgraph.getMarketTrades(marketAddress, { first: SUBGRAPH_SAMPLE_SIZE });
    return buys.length + sells.length;
  } catch {
    return null;
  }
}

/** Pure decision logic — no I/O, unit-testable directly. */
export function decideLongTail(hasConfidentConsensus: boolean, tradeCount: number | null): LongTailResult {
  if (hasConfidentConsensus) {
    return { isLongTail: false, reason: "has a high-quality consensus match", tradeCount };
  }
  if (tradeCount === null) {
    return { isLongTail: false, reason: "subgraph query failed — trade history unknown, not assumed thin", tradeCount: null };
  }
  const isLongTail = tradeCount < THIN_TRADE_COUNT_THRESHOLD;
  return {
    isLongTail,
    reason: isLongTail
      ? `no confident consensus and only ${tradeCount} subgraph trade(s) (< ${THIN_TRADE_COUNT_THRESHOLD})`
      : `no confident consensus but ${tradeCount} subgraph trades (>= ${THIN_TRADE_COUNT_THRESHOLD}) — not thin`,
    tradeCount,
  };
}

/**
 * Classifies a market as long-tail. Returns isLongTail=false (with a reason)
 * when the layer is disabled — callers should still be able to call this
 * unconditionally and just check the flag, rather than branching on
 * layers.bEnabled themselves everywhere. Verified live against the
 * competition subgraph — see the Phase 4 checkpoint report.
 */
export async function classifyLongTail(market: NormalizedMarket, consensus: ConsensusMatch | null): Promise<LongTailResult> {
  if (!layers.bEnabled) {
    return { isLongTail: false, reason: "Layer B disabled", tradeCount: null };
  }

  const hasConfidentConsensus = consensus?.matchQuality === "high";
  if (hasConfidentConsensus) {
    return decideLongTail(true, null);
  }

  const tradeCount = await countSubgraphTrades(market.address);
  return decideLongTail(false, tradeCount);
}
