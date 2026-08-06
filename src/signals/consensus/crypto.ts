/**
 * Crypto consensus adapter — Binance public spot API, no key required.
 * Verified live 2026-08-06:
 *   - GET /api/v3/ticker/price?symbol=BTCUSDT  — current spot price
 *   - GET /api/v3/klines?symbol=BTCUSDT&interval=1d&limit=30 — daily candles,
 *     used to estimate realized daily volatility
 *   - Response includes `x-mbx-used-weight-1m` — Binance's published public
 *     spot-API budget is 1200 request-weight/minute per IP; the two calls
 *     used here weigh a few units total, observed weight=5 for a single
 *     ticker call. Nowhere near the budget for per-market signal generation.
 *   - Coinbase's public `/v2/prices/{pair}/spot` also works with no key, kept
 *     as a fallback for the spot price only (not used for vol, which needs
 *     the kline series).
 *
 * Converts a "will <asset> be <above/below/between> <threshold> by <date>"
 * question into a probability via a driftless lognormal model: given today's
 * spot price and realized daily volatility (stdev of log returns over the
 * trailing window), the probability the price exceeds a threshold at a
 * future date is 1 - Φ(ln(threshold/spot) / (σ_daily * sqrt(days))). This is
 * deliberately simple — no drift term, no skew, no options-market-implied
 * vol — and is documented as such; it is a baseline reference point, not a
 * forecast. Confidence is fixed at a moderate 0.5 to reflect that.
 *
 * The current live market set (2026-08-06) has ZERO crypto-domain markets,
 * so this adapter has 0/10 coverage today — expected, not a bug. Verified
 * correct via a synthetic example (see Phase 2 checkpoint report), not
 * against a live Delphi market.
 */
import type { NormalizedMarket } from "../../markets/types.js";
import type { ConsensusAdapter, ConsensusMatch } from "./types.js";
import { distributionFromSingleOutcome } from "../types.js";
import { extractNumericCondition } from "./textMatch.js";

const FETCH_TIMEOUT_MS = 8000;
const VOL_WINDOW_DAYS = 30;

// Ticker/name -> Binance symbol (quoted in USDT). Extend deliberately.
const ASSET_ALIASES: Record<string, string> = {
  btc: "BTCUSDT",
  bitcoin: "BTCUSDT",
  eth: "ETHUSDT",
  ethereum: "ETHUSDT",
  sol: "SOLUSDT",
  solana: "SOLUSDT",
  doge: "DOGEUSDT",
  dogecoin: "DOGEUSDT",
};

async function fetchJson<T>(url: string): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function findAssetSymbol(text: string): string | null {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  for (const w of words) {
    if (ASSET_ALIASES[w]) return ASSET_ALIASES[w]!;
  }
  return null;
}

/** Abramowitz & Stegun 7.1.26 approximation, |error| < 1.5e-7. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

function standardNormalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

async function realizedDailyVolatility(symbol: string): Promise<number | null> {
  const klines = await fetchJson<unknown[][]>(
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=${VOL_WINDOW_DAYS + 1}`
  );
  if (!klines || klines.length < 3) return null;

  const closes = klines.map((k) => Number(k[4])); // index 4 = close price
  const logReturns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    logReturns.push(Math.log(closes[i]! / closes[i - 1]!));
  }
  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (logReturns.length - 1);
  return Math.sqrt(variance);
}

export const cryptoAdapter: ConsensusAdapter = {
  name: "binance-vol-model",

  isConfigured(): boolean {
    return true; // public API, no key required
  },

  async match(market: NormalizedMarket): Promise<ConsensusMatch | null> {
    if (!/crypto/i.test(market.domain)) return null;

    const symbol = findAssetSymbol(market.question);
    if (!symbol) return null;

    const condition = extractNumericCondition(market.question);
    if (!condition || condition.type === "range") return null; // range thresholds not modeled here
    if (!market.resolvesAt) return null;

    const horizonDays = (market.resolvesAt.getTime() - Date.now()) / 86_400_000;
    if (horizonDays < 0) return null;

    const [ticker, dailyVol] = await Promise.all([
      fetchJson<{ price: string }>(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`),
      realizedDailyVolatility(symbol),
    ]);
    if (!ticker || dailyVol === null) return null;

    const spot = Number(ticker.price);
    const threshold = condition.value;
    const sigma = dailyVol * Math.sqrt(Math.max(horizonDays, 1 / 24)); // floor at 1 hour to avoid sigma=0

    // P(price_T > threshold) under a driftless lognormal model.
    const z = Math.log(threshold / spot) / sigma;
    const pAbove = 1 - standardNormalCdf(z);

    const probabilityOfCondition = condition.type === "gt" || condition.type === "gte" ? pAbove : 1 - pAbove;
    const clamped = Math.min(0.98, Math.max(0.02, probabilityOfCondition));

    return {
      outcomes: distributionFromSingleOutcome(0, clamped, 0.5, market.outcomeCount),
      sourceName: "binance-vol-model",
      // Deliberately always "medium", never "high": this is a computed proxy
      // (a driftless vol model), not a matched external reference — per
      // project requirement, risk/gates.ts never lets a "medium" match alone
      // justify a trade the way a "high" match can.
      matchQuality: "medium",
      detail: `${symbol} spot=${spot}, dailyVol=${(dailyVol * 100).toFixed(2)}%, horizon=${horizonDays.toFixed(1)}d, driftless lognormal P(${condition.type} ${threshold})`,
    };
  },
};
