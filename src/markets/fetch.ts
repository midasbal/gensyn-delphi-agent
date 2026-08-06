import { listOpenMarkets } from "../sdk/client.js";
import { normalizeMarket } from "./normalize.js";
import type { NormalizedMarket } from "./types.js";

/** Fetches open markets and normalizes them. Empty array is a valid result — not an error. */
export async function fetchOpenMarkets(opts?: { limit?: number }): Promise<NormalizedMarket[]> {
  const markets = await listOpenMarkets(opts);
  return markets.map(normalizeMarket);
}
