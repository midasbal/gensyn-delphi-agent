/**
 * Split into its own file deliberately: each test file runs in its own
 * process under tsx --test, so this is the only place that needs
 * signals.oddsApiKey to be genuinely unset. Deletes ODDS_API_KEY via a
 * DYNAMIC import (not hoisted, unlike a static `import`) before importing
 * the adapter, so this doesn't depend on the ambient .env/environment
 * happening to leave ODDS_API_KEY unset — see tests/sportsOdds.test.ts's
 * header comment for why a static import would lose this race.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { NormalizedMarket } from "../src/markets/types.js";

delete process.env.ODDS_API_KEY;
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
