import { test } from "node:test";
import assert from "node:assert/strict";
import { valuePosition, valuePositions, buildValuationContexts, type MarketValuationContext } from "../src/portfolio/valuation.js";
import type { Position } from "../src/portfolio/types.js";

function fakePosition(overrides: Partial<Position> = {}): Position {
  return {
    marketAddress: "0xabc" as `0x${string}`,
    outcomeIdx: 0,
    outcomeLabel: "Yes",
    shares: 10,
    costBasis: 4,
    ...overrides,
  };
}

test("valuePosition — open market values at spot, not cost basis", async () => {
  const position = fakePosition({ shares: 10 });
  const market: MarketValuationContext = { status: "open", winningOutcomeIdx: null, spotPrices: [0.6, 0.4] };
  const result = await valuePosition(position, market);
  assert.equal(result.method, "spot");
  assert.equal(result.provisional, false);
  assert.equal(result.value, 6); // 10 shares * 0.6
});

test("valuePosition — open market with no spot price available falls back to cost basis, marked provisional", async () => {
  const position = fakePosition({ shares: 10, costBasis: 4 });
  const market: MarketValuationContext = { status: "open", winningOutcomeIdx: null, spotPrices: null };
  const result = await valuePosition(position, market);
  assert.equal(result.provisional, true);
  assert.equal(result.value, 4);
});

test("valuePosition — settled market: winning outcome pays exactly 1/share, NO network call needed", async () => {
  const position = fakePosition({ shares: 10, outcomeIdx: 0 });
  const market: MarketValuationContext = { status: "settled", winningOutcomeIdx: 0, spotPrices: null };
  let quoteLiquidateCalled = false;
  const result = await valuePosition(position, market, async () => {
    quoteLiquidateCalled = true;
    return { sharesIn: [0n], totalTokensOut: 0n };
  });
  assert.equal(result.method, "settled-payout");
  assert.equal(result.provisional, false);
  assert.equal(result.value, 10); // 10 shares * 1 TST
  assert.equal(quoteLiquidateCalled, false); // deterministic — no call needed
});

test("valuePosition — settled market: losing outcome pays exactly 0", async () => {
  const position = fakePosition({ shares: 10, outcomeIdx: 1 });
  const market: MarketValuationContext = { status: "settled", winningOutcomeIdx: 0, spotPrices: null };
  const result = await valuePosition(position, market);
  assert.equal(result.method, "settled-payout");
  assert.equal(result.value, 0);
  assert.equal(result.provisional, false);
});

test("valuePosition — settled market with unexpectedly missing winningOutcomeIdx is provisional, not guessed", async () => {
  const position = fakePosition();
  const market: MarketValuationContext = { status: "settled", winningOutcomeIdx: null, spotPrices: null };
  const result = await valuePosition(position, market);
  assert.equal(result.provisional, true);
  assert.equal(result.value, position.costBasis);
});

test("valuePosition — expired market: uses a real quoteLiquidate call, not shares * last price", async () => {
  const position = fakePosition({ shares: 8, costBasis: 3 });
  const market: MarketValuationContext = { status: "expired", winningOutcomeIdx: null, spotPrices: [0.34, 0.66] };
  const result = await valuePosition(position, market, async () => ({ sharesIn: [8n * 10n ** 18n], totalTokensOut: 2_720_000n }));
  assert.equal(result.method, "quoteLiquidate");
  assert.equal(result.provisional, false);
  assert.equal(result.value, 2.72); // 2_720_000 / 1e6 — NOT shares(8) * lastPrice(0.34) = 2.72 coincidentally equal here but via the real quote path
});

test("valuePosition — failed market also uses quoteLiquidate (same LIQUIDATABLE path as expired)", async () => {
  const position = fakePosition({ shares: 5 });
  const market: MarketValuationContext = { status: "failed", winningOutcomeIdx: null, spotPrices: null };
  const result = await valuePosition(position, market, async () => ({ sharesIn: [5n * 10n ** 18n], totalTokensOut: 1_500_000n }));
  assert.equal(result.method, "quoteLiquidate");
  assert.equal(result.value, 1.5);
});

test("valuePosition — quoteLiquidate reverting falls back to cost basis, marked provisional (never a guessed number)", async () => {
  const position = fakePosition({ costBasis: 3 });
  const market: MarketValuationContext = { status: "expired", winningOutcomeIdx: null, spotPrices: null };
  const result = await valuePosition(position, market, async () => {
    throw new Error("revert");
  });
  assert.equal(result.provisional, true);
  assert.equal(result.value, 3);
});

test("valuePosition — unknown market (undefined context) is provisional", async () => {
  const position = fakePosition({ costBasis: 7 });
  const result = await valuePosition(position, undefined);
  assert.equal(result.provisional, true);
  assert.equal(result.value, 7);
});

test("buildValuationContexts — fills in a market missing from the known map via fetchMarket, leaves known ones untouched", async () => {
  const positions = [fakePosition({ marketAddress: "0xknown" as `0x${string}` }), fakePosition({ marketAddress: "0xmissing" as `0x${string}` })];
  const known = new Map<string, MarketValuationContext>([["0xknown", { status: "open", winningOutcomeIdx: null, spotPrices: [0.5, 0.5] }]]);

  const result = await buildValuationContexts(positions, known, async (address) => {
    assert.equal(address, "0xmissing");
    return { status: "settled", winningOutcomeIdx: "0", spotPrices: [1, 0] } as any;
  });

  assert.equal(result.get("0xknown")!.status, "open");
  assert.equal(result.get("0xmissing")!.status, "settled");
  assert.equal(result.get("0xmissing")!.winningOutcomeIdx, 0);
});

test("buildValuationContexts — a fetch failure leaves the market unset (position values provisional downstream), never throws", async () => {
  const positions = [fakePosition({ marketAddress: "0xdead" as `0x${string}` })];
  const result = await buildValuationContexts(positions, new Map(), async () => {
    throw new Error("network error");
  });
  assert.equal(result.has("0xdead"), false);
});

test("valuePositions — values a mixed batch of open/settled/expired positions correctly and keys them consistently", async () => {
  const positions = [
    fakePosition({ marketAddress: "0x1" as `0x${string}`, outcomeIdx: 0, shares: 10 }),
    fakePosition({ marketAddress: "0x2" as `0x${string}`, outcomeIdx: 0, shares: 4 }),
  ];
  const contexts = new Map<string, MarketValuationContext>([
    ["0x1", { status: "open", winningOutcomeIdx: null, spotPrices: [0.7, 0.3] }],
    ["0x2", { status: "settled", winningOutcomeIdx: 0, spotPrices: null }],
  ]);
  const result = await valuePositions(positions, contexts);
  assert.equal(result.get("0x1-0")!.value, 7);
  assert.equal(result.get("0x2-0")!.value, 4);
});
