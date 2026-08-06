/**
 * Read-only connectivity healthcheck for the Gensyn Delphi agent trading
 * competition (competition-testnet). Lists open markets and sanity-checks
 * LMSR pricing (outcome prices should sum to ~1). Places no trades.
 *
 * Usage: npm run healthcheck
 */
import "dotenv/config";
import { DelphiClient } from "@gensyn-ai/gensyn-delphi-sdk";

// This only checks that we're reading LMSR data on the right network (prices
// sum to 1 up to floating-point error) — unrelated to trade slippage tolerance.
const PROB_SUM_EPSILON = 1e-6;

try {
  const client = new DelphiClient({
    network: "competition-testnet",
  });

  console.log("Connected DelphiClient to competition-testnet.\n");

  const { markets } = await client.listMarkets({
    status: "open",
    limit: 50,
    pricesAndImpliedProbabilities: true,
  });

  if (!markets || markets.length === 0) {
    console.log("No open markets found.");
    console.log(
      "This is a valid state — it likely means no competition is currently flagged active, or the active one has no open markets yet. Not an error."
    );
    process.exit(0);
  }

  console.log(`Found ${markets.length} open market(s):\n`);

  let flaggedCount = 0;
  let listMarketsHadPrices = 0;
  let fetchedViaGetMarket = 0;

  for (const market of markets) {
    let meta = market.metadata;
    let outcomes = meta?.outcomes ?? [];
    let prices = market.spotPrices ?? [];

    if (prices.length > 0) {
      listMarketsHadPrices++;
    } else {
      // listMarkets didn't return price data for this market — fall back to
      // getMarket, which fetches spotPrices/spotImpliedProbabilities directly.
      const full = await client.getMarket({
        id: market.id,
        pricesAndImpliedProbabilities: true,
      });
      meta = full.metadata;
      outcomes = meta?.outcomes ?? [];
      prices = full.spotPrices ?? [];
      fetchedViaGetMarket++;
    }

    console.log("Address:  " + market.id);
    console.log("Question: " + (meta?.question ?? "(no metadata)"));
    console.log("Outcomes: " + (outcomes.length > 0 ? outcomes.join(", ") : "—"));

    if (prices.length > 0) {
      for (let i = 0; i < outcomes.length; i++) {
        const p = prices[i];
        console.log(`  [${i}] ${outcomes[i]}: ${p !== undefined ? p.toFixed(4) : "—"}`);
      }

      const sum = prices.reduce((acc, p) => acc + p, 0);
      const ok = Math.abs(sum - 1) <= PROB_SUM_EPSILON;
      console.log(`  Sum of prices: ${sum.toFixed(10)} ${ok ? "(OK, sums to 1)" : "(WARNING — does not sum to 1; investigate network/market)"}`);
      if (!ok) flaggedCount++;
    } else {
      console.log("  (no price data returned, even via getMarket)");
    }

    console.log("---");
  }

  console.log(`\nTotal open markets: ${markets.length}`);
  console.log(`Markets with prices from listMarkets directly: ${listMarketsHadPrices}`);
  console.log(`Markets that needed a getMarket fallback for prices: ${fetchedViaGetMarket}`);
  console.log(`Markets flagged for LMSR sum-to-1 violation (epsilon=${PROB_SUM_EPSILON}): ${flaggedCount}`);
} catch (err) {
  console.error("Healthcheck FAILED. Full error object:\n");
  console.error(err);
  process.exit(1);
}
