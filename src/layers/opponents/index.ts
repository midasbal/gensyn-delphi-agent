/**
 * Layer D — opponent modeling. PUBLIC data only (the Goldsky subgraph's
 * gatewayBuys/gatewaySells — anyone can query this), never our own state or
 * any private channel.
 *
 * Compliance argument (per the project's non-negotiable rules — no
 * collusion, no coordination, no wash trading, no trade whose purpose is to
 * move price):
 *   This layer NEVER produces a trade decision on its own. detectHerding()
 *   only classifies public trade-feed activity, and only once there's
 *   enough of it to mean anything — BOTH a minimum trade count
 *   (D_MIN_TRADES) AND a minimum total notional (D_MIN_NOTIONAL, in TST)
 *   in the observed window, so a handful of dust-sized trades can't be
 *   mistaken for a real crowd (Phase 5 carry-forward correction).
 *   corroboratesFade() only returns true when an ALREADY-selected candidate
 *   (chosen independently by risk/gates.ts's selectCandidate() from our own
 *   combined signal, per Phase 3) is on the opposite side of a detected
 *   herding burst — i.e. we were already going to consider this trade
 *   because OUR signal said the crowd-favored outcome looks overpriced;
 *   this layer only adds corroborating confidence to a trade that would
 *   exist without it. Because it only ever touches CONFIDENCE (gate a) and
 *   never EDGE (gate c, computed upstream in signals/combine.ts and
 *   unaffected by this layer), it structurally cannot lift a
 *   sub-edge-threshold candidate into a trade by itself. If our own signal
 *   doesn't already support the other side, this layer changes nothing —
 *   "fade the feed alone" is explicitly not implemented, because trading
 *   purely because a crowd moved price (with no independent information
 *   backing the other side) is a price-driven trade, which the rules
 *   prohibit regardless of direction.
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
const HERD_FRACTION_THRESHOLD = 0.75; // >= this fraction of the recent window in one direction

export interface FeedTrade {
  outcomeIdx: number;
  side: "buy" | "sell";
  timestampSec: number;
  /** TST value of the trade (tokensIn for a buy, tokensOut for a sell) — used for the minimum-notional check. */
  notionalTst: number;
}

/** Fetches and normalizes the most recent public trades for a market. Never throws — a query failure returns null (unknown), not an empty/assumed-quiet feed. */
export async function fetchRecentTrades(marketAddress: string, first: number = RECENT_TRADE_WINDOW): Promise<FeedTrade[] | null> {
  try {
    const subgraph = getSubgraph();
    const { buys, sells } = await subgraph.getMarketTrades(marketAddress, { first });
    const trades: FeedTrade[] = [
      ...buys
        .filter((b) => b.outcomeIdx !== null && b.timestamp_ !== null)
        .map((b) => ({
          outcomeIdx: Number(b.outcomeIdx),
          side: "buy" as const,
          timestampSec: Number(b.timestamp_),
          notionalTst: Number(BigInt(b.tokensIn ?? "0")) / 1e6,
        })),
      ...sells
        .filter((s) => s.outcomeIdx !== null && s.timestamp_ !== null)
        .map((s) => ({
          outcomeIdx: Number(s.outcomeIdx),
          side: "sell" as const,
          timestampSec: Number(s.timestamp_),
          notionalTst: Number(BigInt(s.tokensOut ?? "0")) / 1e6,
        })),
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
  totalNotional: number;
  reason: string;
}

/**
 * Pure — no I/O, and no config lookup (unit-testable directly regardless of
 * D_ENABLED) — minTrades/minNotional are passed explicitly (getHerdingSignal
 * supplies them from config). A burst is "buys concentrated on one outcome"
 * — sells don't count toward herding-in, only toward the denominator via
 * net direction.
 */
export function detectHerding(trades: FeedTrade[] | null, minTrades: number, minNotional: number): HerdingResult {
  if (trades === null) {
    return { detected: false, direction: null, burstFraction: null, sampleSize: 0, totalNotional: 0, reason: "subgraph query failed — feed unknown, not assumed quiet" };
  }

  const totalNotional = trades.reduce((sum, t) => sum + t.notionalTst, 0);

  if (trades.length < minTrades) {
    return { detected: false, direction: null, burstFraction: null, sampleSize: trades.length, totalNotional, reason: `only ${trades.length} recent trade(s) — below the minimum trade count (${minTrades}) to mean anything` };
  }
  if (totalNotional < minNotional) {
    return { detected: false, direction: null, burstFraction: null, sampleSize: trades.length, totalNotional, reason: `only ${totalNotional.toFixed(4)} TST total notional in the window — below the minimum (${minNotional} TST); a handful of dust trades isn't a crowd` };
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
    totalNotional,
    reason: detected
      ? `${topCount}/${trades.length} recent trades (${(fraction * 100).toFixed(0)}%, ${totalNotional.toFixed(2)} TST notional) are buys on outcome[${topOutcome}]`
      : `no single-outcome buy concentration >= ${HERD_FRACTION_THRESHOLD * 100}% in the last ${trades.length} trades`,
  };
}

/** I/O entry point: checks layers.dEnabled, fetches the live feed, and detects using the configured D_MIN_TRADES/D_MIN_NOTIONAL. This is what loop/paperLoop.ts calls. */
export async function getHerdingSignal(marketAddress: string): Promise<HerdingResult> {
  if (!layers.dEnabled) {
    return { detected: false, direction: null, burstFraction: null, sampleSize: 0, totalNotional: 0, reason: "Layer D disabled" };
  }
  const trades = await fetchRecentTrades(marketAddress);
  return detectHerding(trades, layers.dMinTrades, layers.dMinNotional);
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

/** Small, capped confidence bump — never enough on its own to cross a gate that a real signal wasn't already going to clear. Touches confidence only, never edge — see file header for why that makes this structurally incapable of lifting a sub-edge-threshold candidate into a trade. */
export function applyCorroborationBump(confidence: number, herding: HerdingResult, candidateOutcomeIdx: number): number {
  if (!corroboratesFade(herding, candidateOutcomeIdx)) return confidence;
  return Math.min(1, confidence + CORROBORATION_CONFIDENCE_BUMP);
}
