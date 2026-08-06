/**
 * Synthetic demo for the crypto consensus adapter (src/signals/consensus/crypto.ts).
 * The live competition market set (2026-08-06) has ZERO crypto-domain
 * markets, so this adapter can't be exercised against a real Delphi market
 * yet — this constructs a fake NormalizedMarket to prove the Binance calls +
 * vol model actually work end-to-end. Read-only; hits real Binance public
 * endpoints.
 *
 * Usage: npm run demo-crypto-adapter
 */
import { cryptoAdapter } from "../src/signals/consensus/crypto.js";
import type { NormalizedMarket } from "../src/markets/types.js";

const resolvesAt = new Date(Date.now() + 14 * 86_400_000); // 14 days out

const fakeMarket: NormalizedMarket = {
  address: "0x0000000000000000000000000000000000dead",
  appMarketId: "demo",
  marketUrl: "https://example.invalid",
  status: "open",
  category: "crypto",
  domain: "crypto",
  question: "Will BTC be above $50,000 by the resolution date?",
  outcomes: ["Yes", "No"],
  outcomeCount: 2,
  spotPrices: [0.5, 0.5],
  spotImpliedProbabilities: [0.5, 0.5],
  pricesSumToOne: true,
  tradingFeePct: null,
  verifiable: false,
  createdAt: new Date(),
  resolvesAt,
  settlesAt: resolvesAt,
  winningOutcomeIdx: null,
  resolution: {
    rawQuestion: "Will BTC be above $50,000 by the resolution date?",
    criteria: "Will BTC be above $50,000",
    timingPhrase: null,
    timingDateHint: null,
    timingMatchesResolvesAt: null,
  },
  raw: {} as NormalizedMarket["raw"],
};

console.log("Synthetic market:", fakeMarket.question, "| resolvesAt:", resolvesAt.toISOString());
const result = await cryptoAdapter.match(fakeMarket);
console.log("crypto adapter result:", JSON.stringify(result, null, 2));
