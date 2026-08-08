/**
 * Split into its own file deliberately: each test file runs in its own
 * process under tsx --test, so this is the only place that needs
 * signals.oddsApiKey to be genuinely unset. Forces ODDS_API_KEY empty via
 * a DYNAMIC import (not hoisted, unlike a static `import`) before
 * importing the adapter, so this doesn't depend on the ambient
 * .env/environment happening to leave ODDS_API_KEY unset — see
 * tests/sportsOdds.test.ts's header comment for why a static import would
 * lose this race.
 *
 * Not hermetic bug (found on a server whose real .env has ODDS_API_KEY
 * set): `delete process.env.ODDS_API_KEY` is NOT enough — config/index.ts
 * imports "dotenv/config" as a side effect of the dynamic import below,
 * and dotenv's default populate() only skips a key that's already PRESENT
 * in process.env (`hasOwnProperty`, not truthiness); `delete` removes the
 * property entirely, so dotenv sees it as absent and happily refills it
 * from the real .env file during that very import — silently undoing the
 * delete before config/index.ts ever reads it. Setting it to an EMPTY
 * STRING instead keeps the property present (so dotenv leaves it alone)
 * while still being falsy (so config/index.ts's own
 * `process.env.ODDS_API_KEY || undefined` correctly treats it as unset).
 * Reproduced locally by temporarily adding a real ODDS_API_KEY line to
 * .env: the `delete` version failed exactly like the report described;
 * this version passes both with and without a real key in .env.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { NormalizedMarket } from "../src/markets/types.js";

process.env.ODDS_API_KEY = "";
const { sportsOddsAdapter } = await import("../src/signals/consensus/sportsOdds.js");

test("sportsOdds — unconfigured (no ODDS_API_KEY) returns null without making any request", async () => {
  assert.equal(sportsOddsAdapter.isConfigured(), false);

  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    throw new Error("should never be called when unconfigured");
  }) as typeof fetch;
  try {
    const market: NormalizedMarket = {
      address: "0x0000000000000000000000000000000000dead",
      appMarketId: "fake",
      marketUrl: "https://example.invalid",
      status: "open",
      category: "sports",
      domain: "sports",
      question: "Will the Hamilton Tiger-Cats beat the BC Lions?",
      outcomes: ["Yes", "No"],
      outcomeCount: 2,
      spotPrices: [0.5, 0.5],
      spotImpliedProbabilities: [0.5, 0.5],
      pricesSumToOne: true,
      tradingFeePct: null,
      verifiable: false,
      createdAt: new Date(),
      resolvesAt: new Date("2026-08-15T00:00:00.000Z"),
      settlesAt: new Date("2026-08-15T00:00:00.000Z"),
      winningOutcomeIdx: null,
      resolution: { rawQuestion: "", criteria: "", timingPhrase: null, timingDateHint: null, timingMatchesResolvesAt: null },
      raw: {} as NormalizedMarket["raw"],
    };
    const result = await sportsOddsAdapter.match(market);
    assert.equal(result, null);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = original;
  }
});
