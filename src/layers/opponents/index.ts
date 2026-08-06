/**
 * Layer D — opponent modeling. PUBLIC data only (the Goldsky subgraph's
 * gatewayBuys/gatewaySells — anyone can query this), never our own state or
 * any private channel.
 *
 * Compliance argument (per the project's non-negotiable rules — no
 * collusion, no coordination, no wash trading, no trade whose purpose is to
 * move price):
 *   This layer NEVER produces a trade decision on its own. detectHerding()
 *   only classifies public trade-feed activity. corroboratesFade() only
 *   returns true when an ALREADY-selected candidate (chosen independently
 *   by risk/gates.ts's selectCandidate() from our own combined signal, per
 *   Phase 3) is on the opposite side of a detected herding burst — i.e. we
 *   were already going to consider this trade because OUR signal said the
 *   crowd-favored outcome looks overpriced; this layer only adds
 *   corroborating confidence to a trade that would exist without it. If our
 *   own signal doesn't already support the other side, this layer changes
 *   nothing — "fade the feed alone" is explicitly not implemented, because
 *   trading purely because a crowd moved price (with no independent
 *   information backing the other side) is a price-driven trade, which the
 *   rules prohibit regardless of direction.
 *
 * Wired and unit-tested against LIVE subgraph data this phase (see the
 * Phase 4 checkpoint report) — but every current competition market has
 * zero subgraph trade history (confirmed via Layer B's same query), so
 * detectHerding() correctly returns "insufficient data" for all 10 live
 * markets today. This layer is a no-op until real competitors actually
 * trade — exactly as the project brief anticipated ("validate live").
 */
import { getSubgraph } from "../../sdk/client.js";
import { layers } from "../../config/index.js";

const RECENT_TRADE_WINDOW = 20; // how many of the most recent trades to look at
const MIN_BURST_SIZE = 5; // need at least this many recent trades before "herding" means anything
const HERD_FRACTION_THRESHOLD = 0.75; // >= this fraction of the recent window in one direction

export interface FeedTrade {
  outcomeIdx: number;
  side: "buy" | "sell";
  timestampSec: number;
}

/** Fetches and normalizes the most recent public trades for a market. Never throws — a query failure returns null (unknown), not an empty/assumed-quiet feed. */
export async function fetchRecentTrades(marketAddress: string, first: number = RECENT_TRADE_WINDOW): Promise<FeedTrade[] | null> {
  try {
    const subgraph = getSubgraph();
    const { buys, sells } = await subgraph.getMarketTrades(marketAddress, { first });
    const trades: FeedTrade[] = [
      ...buys
        .filter((b) => b.outcomeIdx !== null && b.timestamp_ !== null)
        .map((b) => ({ outcomeIdx: Number(b.outcomeIdx), side: "buy" as const, timestampSec: Number(b.timestamp_) })),
      ...sells
        .filter((s) => s.outcomeIdx !== null && s.timestamp_ !== null)
        .map((s) => ({ outcomeIdx: Number(s.outcomeIdx), side: "sell" as const, timestampSec: Number(s.timestamp_) })),
    ];
    trades.sort((a, b) => b.timestampSec - a.timestampSec); // most recent first
    return trades;
  } catch {
    return null;
  }
}

export interface HerdingResult {
  detected: boolean;
  /** The outcome index the herd is buying into, if detected. */
  direction: number | null;
  burstFraction: number | null;
  sampleSize: number;
  reason: string;
}

/** Pure — no I/O, and no config lookup (unit-testable directly regardless of D_ENABLED). A burst is "buys concentrated on one outcome" — sells don't count toward herding-in, only toward the denominator via net direction. Callers gate this on layers.dEnabled themselves (see getHerdingSignal). */
export function detectHerding(trades: FeedTrade[] | null): HerdingResult {
  if (trades === null) {
    return { detected: false, direction: null, burstFraction: null, sampleSize: 0, reason: "subgraph query failed — feed unknown, not assumed quiet" };
  }
  if (trades.length < MIN_BURST_SIZE) {
    return { detected: false, direction: null, burstFraction: null, sampleSize: trades.length, reason: `only ${trades.length} recent trade(s) — below the minimum burst size (${MIN_BURST_SIZE}) to mean anything` };
  }

  const buyCountByOutcome = new Map<number, number>();
  for (const t of trades) {
    if (t.side !== "buy") continue;
    buyCountByOutcome.set(t.outcomeIdx, (buyCountByOutcome.get(t.outcomeIdx) ?? 0) + 1);
  }

  let topOutcome: number | null = null;
  let topCount = 0;
  for (const [outcomeIdx, count] of buyCountByOutcome) {
    if (count > topCount) {
      topCount = count;
      topOutcome = outcomeIdx;
    }
  }

  const fraction = topCount / trades.length;
  const detected = topOutcome !== null && fraction >= HERD_FRACTION_THRESHOLD;

  return {
    detected,
    direction: detected ? topOutcome : null,
    burstFraction: fraction,
    sampleSize: trades.length,
    reason: detected
      ? `${topCount}/${trades.length} recent trades (${(fraction * 100).toFixed(0)}%) are buys on outcome[${topOutcome}]`
      : `no single-outcome buy concentration >= ${HERD_FRACTION_THRESHOLD * 100}% in the last ${trades.length} trades`,
  };
}

/** I/O entry point: checks layers.dEnabled, fetches the live feed, and detects. This is what loop/paperLoop.ts calls. */
export async function getHerdingSignal(marketAddress: string): Promise<HerdingResult> {
  if (!layers.dEnabled) {
    return { detected: false, direction: null, burstFraction: null, sampleSize: 0, reason: "Layer D disabled" };
  }
  const trades = await fetchRecentTrades(marketAddress);
  return detectHerding(trades);
}

/**
 * True only when a detected herding burst is on the OPPOSITE outcome from
 * our already-independently-selected candidate — i.e. the crowd has been
 * piling into the outcome we think is overpriced, corroborating (not
 * causing) the trade we were already considering. See file header.
 */
export function corroboratesFade(herding: HerdingResult, candidateOutcomeIdx: number): boolean {
  return herding.detected && herding.direction !== null && herding.direction !== candidateOutcomeIdx;
}

const CORROBORATION_CONFIDENCE_BUMP = 0.1;

/** Small, capped confidence bump — never enough on its own to cross a gate that a real signal wasn't already going to clear. */
export function applyCorroborationBump(confidence: number, herding: HerdingResult, candidateOutcomeIdx: number): number {
  if (!corroboratesFade(herding, candidateOutcomeIdx)) return confidence;
  return Math.min(1, confidence + CORROBORATION_CONFIDENCE_BUMP);
}
