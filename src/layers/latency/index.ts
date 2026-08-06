/**
 * Layer A — latency.
 *
 * Deliberately consensus-driven and LLM-free: the whole point is to be fast
 * and cheap enough to poll on a short cadence (A_POLL_SECONDS) without
 * burning LLM budget (that's F2's job to protect). The "reference" here is
 * whatever findConsensusMatch() returns (Polymarket/Odds/Binance-vol — none
 * of which call an LLM), plus the market's own live on-chain price. When
 * either moves past A_REFERENCE_MOVE_THRESHOLD since we last acted on this
 * market, it jumps to the front of the re-evaluation queue.
 *
 * This layer's actual polling cadence (an interval timer ticking every
 * A_POLL_SECONDS) belongs to Phase 5's persistent scheduler — loop/ today is
 * a single decision pass, not a long-running process. What's built here is
 * everything the scheduler will call: pollOnce() for one polling pass, and
 * prioritizeQueue() to reorder the next pass's market list. This layer only
 * ever reorders/flags — see loop/paperLoop.ts for how it feeds the existing
 * pipeline rather than trading on its own.
 */
import type { NormalizedMarket } from "../../markets/types.js";
import { findConsensusMatch } from "../../signals/consensus/index.js";
import { layers } from "../../config/index.js";

export interface LastActed {
  referenceProbability: number | null;
  price: number;
}

// Per-market "what we last acted on" baseline. Process-lifetime only —
// Phase 5's persistent process is what makes this actually durable across
// polls; a fresh process (like every script in this project today) starts
// with an empty baseline, which is the correct/safe default: no known prior
// value means nothing has "moved" relative to it yet.
const lastActed = new Map<string, LastActed>();

export function recordActedReference(marketAddress: string, referenceProbability: number | null, price: number): void {
  lastActed.set(marketAddress, { referenceProbability, price });
}

export function getLastActed(marketAddress: string): LastActed | undefined {
  return lastActed.get(marketAddress);
}

export function clearLastActed(): void {
  lastActed.clear();
}

export interface MoveCheck {
  moved: boolean;
  referenceDelta: number | null;
  priceDelta: number | null;
  reason: string;
}

/** Pure — no I/O. Compares current reference/price against the stored baseline. */
export function checkMove(marketAddress: string, currentReferenceProbability: number | null, currentPrice: number, threshold: number): MoveCheck {
  const baseline = lastActed.get(marketAddress);
  if (!baseline) {
    return { moved: false, referenceDelta: null, priceDelta: null, reason: "no prior baseline — nothing to compare against yet" };
  }

  const referenceDelta =
    baseline.referenceProbability !== null && currentReferenceProbability !== null
      ? Math.abs(currentReferenceProbability - baseline.referenceProbability)
      : null;
  const priceDelta = Math.abs(currentPrice - baseline.price);

  const referenceMoved = referenceDelta !== null && referenceDelta >= threshold;
  const priceMoved = priceDelta >= threshold;

  if (referenceMoved || priceMoved) {
    const parts: string[] = [];
    if (referenceMoved) parts.push(`reference moved ${referenceDelta!.toFixed(3)} (>= ${threshold})`);
    if (priceMoved) parts.push(`price moved ${priceDelta.toFixed(3)} (>= ${threshold})`);
    return { moved: true, referenceDelta, priceDelta, reason: parts.join("; ") };
  }

  return { moved: false, referenceDelta, priceDelta, reason: "within threshold since last-acted baseline" };
}

export interface LatencyPollResult {
  market: NormalizedMarket;
  currentReferenceProbability: number | null;
  currentPrice: number;
  move: MoveCheck;
}

/**
 * One polling pass: cheaply (no LLM) fetches each market's current
 * consensus reference + on-chain price and checks it against the stored
 * baseline. Never throws per-market — a failed consensus lookup for one
 * market yields currentReferenceProbability=null (checked against price
 * only), not a crash for the whole pass.
 */
export async function pollOnce(markets: NormalizedMarket[]): Promise<LatencyPollResult[]> {
  if (!layers.aEnabled) {
    return markets.map((market) => ({
      market,
      currentReferenceProbability: null,
      currentPrice: market.spotPrices?.[0] ?? NaN,
      move: { moved: false, referenceDelta: null, priceDelta: null, reason: "Layer A disabled" },
    }));
  }

  const results: LatencyPollResult[] = [];
  for (const market of markets) {
    const currentPrice = market.spotPrices?.[0] ?? NaN;
    let currentReferenceProbability: number | null = null;
    try {
      const { match } = await findConsensusMatch(market);
      currentReferenceProbability = match?.outcomes[0]?.probability ?? null;
    } catch {
      currentReferenceProbability = null;
    }
    const move = checkMove(market.address, currentReferenceProbability, currentPrice, layers.aReferenceMoveThreshold);
    results.push({ market, currentReferenceProbability, currentPrice, move });
  }
  return results;
}

/** Stable-sorts moved markets to the front — everything else keeps its original relative order. */
export function prioritizeQueue<T extends { market: NormalizedMarket; move: MoveCheck }>(pollResults: T[]): NormalizedMarket[] {
  const moved = pollResults.filter((r) => r.move.moved).map((r) => r.market);
  const unmoved = pollResults.filter((r) => !r.move.moved).map((r) => r.market);
  return [...moved, ...unmoved];
}
