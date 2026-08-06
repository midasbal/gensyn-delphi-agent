/**
 * Phase 1 checkpoint helper: fetch + normalize the live open market set and
 * print the internal Market shape for inspection. Read-only.
 *
 * Usage: npm run print-markets
 */
import { fetchOpenMarkets } from "../src/markets/index.js";

const markets = await fetchOpenMarkets({ limit: 50 });

if (markets.length === 0) {
  console.log("No open markets found. Valid state — no active competition markets right now.");
  process.exit(0);
}

console.log(`Fetched + normalized ${markets.length} open market(s):\n`);

for (const m of markets) {
  console.log(JSON.stringify(
    {
      address: m.address,
      status: m.status,
      category: m.category,
      domain: m.domain,
      question: m.question,
      outcomes: m.outcomes,
      spotPrices: m.spotPrices,
      pricesSumToOne: m.pricesSumToOne,
      tradingFeePct: m.tradingFeePct,
      resolvesAt: m.resolvesAt,
      resolution: {
        criteria: m.resolution.criteria,
        timingPhrase: m.resolution.timingPhrase,
        timingDateHint: m.resolution.timingDateHint,
        timingMatchesResolvesAt: m.resolution.timingMatchesResolvesAt,
      },
    },
    null,
    2
  ));
  console.log("---");
}
