import { test } from "node:test";
import assert from "node:assert/strict";
import { checkMove, recordActedReference, clearLastActed, prioritizeQueue } from "../src/layers/latency/index.js";
import { decideLongTail, THIN_TRADE_COUNT_THRESHOLD } from "../src/layers/longtail/index.js";
import { checkWithinMarketCoherence } from "../src/layers/coherence/withinMarket.js";
import { findRelatedPairs, detectJointIncoherence, type MarketWithSubject } from "../src/layers/coherence/acrossMarket.js";
import { planArbitragePair } from "../src/layers/coherence/arbitragePair.js";
import { detectHerding, corroboratesFade, applyCorroborationBump, type FeedTrade } from "../src/layers/opponents/index.js";
import type { NormalizedMarket } from "../src/markets/types.js";

function fakeMarket(overrides: Partial<NormalizedMarket>): NormalizedMarket {
  const resolvesAt = overrides.resolvesAt ?? new Date("2026-08-10T00:00:00Z");
  return {
    address: "0x0000000000000000000000000000000000dead" as `0x${string}`,
    appMarketId: "fake",
    marketUrl: "https://example.invalid",
    status: "open",
    category: "miscellaneous",
    domain: "miscellaneous",
    question: "Will X happen?",
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
    resolution: { rawQuestion: "Will X happen?", criteria: "Will X happen", timingPhrase: null, timingDateHint: null, timingMatchesResolvesAt: null },
    raw: {} as NormalizedMarket["raw"],
    ...overrides,
  };
}

// ---------- Layer A: latency ----------

test("Layer A checkMove — no baseline yet means not moved", () => {
  clearLastActed();
  const result = checkMove("0xabc", 0.6, 0.5, 0.05);
  assert.equal(result.moved, false);
  assert.match(result.reason, /no prior baseline/);
});

test("Layer A checkMove — reference move past threshold triggers", () => {
  clearLastActed();
  recordActedReference("0xabc", 0.5, 0.5);
  const result = checkMove("0xabc", 0.6, 0.5, 0.05);
  assert.equal(result.moved, true);
  assert.match(result.reason, /reference moved/);
});

test("Layer A checkMove — price move past threshold triggers even if reference unchanged", () => {
  clearLastActed();
  recordActedReference("0xabc", 0.5, 0.5);
  const result = checkMove("0xabc", 0.5, 0.6, 0.05);
  assert.equal(result.moved, true);
  assert.match(result.reason, /price moved/);
});

test("Layer A checkMove — within threshold does not trigger", () => {
  clearLastActed();
  recordActedReference("0xabc", 0.5, 0.5);
  const result = checkMove("0xabc", 0.51, 0.51, 0.05);
  assert.equal(result.moved, false);
});

test("Layer A prioritizeQueue — moved markets jump to the front, order otherwise preserved", () => {
  const m1 = fakeMarket({ address: "0x1" as `0x${string}` });
  const m2 = fakeMarket({ address: "0x2" as `0x${string}` });
  const m3 = fakeMarket({ address: "0x3" as `0x${string}` });
  const results = [
    { market: m1, move: { moved: false, referenceDelta: null, priceDelta: null, reason: "" } },
    { market: m2, move: { moved: true, referenceDelta: 0.1, priceDelta: null, reason: "" } },
    { market: m3, move: { moved: false, referenceDelta: null, priceDelta: null, reason: "" } },
  ];
  const queue = prioritizeQueue(results);
  assert.deepEqual(queue.map((m) => m.address), ["0x2", "0x1", "0x3"]);
});

// ---------- Layer B: long-tail ----------

test("Layer B decideLongTail — confident consensus means not long-tail", () => {
  const result = decideLongTail(true, null);
  assert.equal(result.isLongTail, false);
  assert.match(result.reason, /consensus match/);
});

test("Layer B decideLongTail — no consensus + thin trade history means long-tail", () => {
  const result = decideLongTail(false, THIN_TRADE_COUNT_THRESHOLD - 1);
  assert.equal(result.isLongTail, true);
});

test("Layer B decideLongTail — no consensus but active trading means not long-tail", () => {
  const result = decideLongTail(false, THIN_TRADE_COUNT_THRESHOLD + 5);
  assert.equal(result.isLongTail, false);
});

test("Layer B decideLongTail — unknown trade count (query failed) is not assumed thin", () => {
  const result = decideLongTail(false, null);
  assert.equal(result.isLongTail, false);
  assert.match(result.reason, /query failed/);
});

// ---------- Layer C: coherence ----------

test("Layer C withinMarket — flags drift beyond epsilon", () => {
  const market = fakeMarket({ spotPrices: [0.5, 0.5001] });
  const result = checkWithinMarketCoherence(market);
  assert.equal(result.flagged, true);
  assert.ok(result.drift! > 0);
});

test("Layer C withinMarket — does not flag prices that sum to 1", () => {
  const market = fakeMarket({ spotPrices: [0.62, 0.38] });
  const result = checkWithinMarketCoherence(market);
  assert.equal(result.flagged, false);
});

test("Layer C findRelatedPairs — high overlap classified confident, low overlap logged-only, no overlap dropped", () => {
  const a: MarketWithSubject = { market: fakeMarket({ address: "0x1" as `0x${string}` }), subject: "Federal Reserve interest rate decision December" };
  const b: MarketWithSubject = { market: fakeMarket({ address: "0x2" as `0x${string}` }), subject: "Federal Reserve interest rate decision January" };
  const c: MarketWithSubject = { market: fakeMarket({ address: "0x3" as `0x${string}` }), subject: "completely unrelated golf tournament outcome" };
  const pairs = findRelatedPairs([a, b, c]);
  const ab = pairs.find((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a));
  assert.ok(ab);
  assert.equal(ab!.confidence, "high");
  const withC = pairs.filter((p) => p.a === c || p.b === c);
  assert.equal(withC.length, 0);
});

test("Layer C detectJointIncoherence — flags divergent near-duplicate markets", () => {
  const a: MarketWithSubject = { market: fakeMarket({ address: "0x1" as `0x${string}`, spotPrices: [0.3, 0.7] }), subject: "Will the Fed cut rates in December" };
  const b: MarketWithSubject = { market: fakeMarket({ address: "0x2" as `0x${string}`, spotPrices: [0.55, 0.45] }), subject: "Will the Fed cut rates in December" };
  const pairs = findRelatedPairs([a, b]);
  assert.equal(pairs.length, 1);
  const flag = detectJointIncoherence(pairs[0]!);
  assert.ok(flag);
  assert.equal(flag!.flagged, true);
});

test("Layer C detectJointIncoherence — does not flag pairs below the near-duplicate threshold", () => {
  const a: MarketWithSubject = { market: fakeMarket({ address: "0x1" as `0x${string}` }), subject: "Federal Reserve interest rate decision" };
  const b: MarketWithSubject = { market: fakeMarket({ address: "0x2" as `0x${string}` }), subject: "Federal Reserve press conference schedule" };
  const pairs = findRelatedPairs([a, b]);
  for (const p of pairs) {
    assert.equal(detectJointIncoherence(p), null);
  }
});

test("Layer C planArbitragePair — sizes a genuine flagged incoherence with injected quotes", async () => {
  const a: MarketWithSubject = { market: fakeMarket({ address: "0x1" as `0x${string}`, spotPrices: [0.3, 0.7] }), subject: "Will the Fed cut rates in December" };
  const b: MarketWithSubject = { market: fakeMarket({ address: "0x2" as `0x${string}`, spotPrices: [0.55, 0.45] }), subject: "Will the Fed cut rates in December" };
  const pairs = findRelatedPairs([a, b]);
  const flag = detectJointIncoherence(pairs[0]!)!;

  const plan = await planArbitragePair(flag, 1, async (marketAddress, outcomeIdx) => {
    // cheap leg = market a outcome 0 (0.30), expensive leg = market b outcome 1 (1-0.55=0.45)
    if (marketAddress === a.market.address && outcomeIdx === 0) return { tokensIn: 0.3 };
    if (marketAddress === b.market.address && outcomeIdx === 1) return { tokensIn: 0.45 };
    throw new Error("unexpected quote call");
  });

  assert.ok(plan);
  assert.ok(plan!.expectedProfit > 0);
  assert.ok(Math.abs(plan!.totalCost - 0.75) < 1e-9);
});

test("Layer C planArbitragePair — refuses a non-binary pair", async () => {
  const a: MarketWithSubject = { market: fakeMarket({ address: "0x1" as `0x${string}`, outcomeCount: 3, outcomes: ["A", "B", "C"], spotPrices: [0.3, 0.3, 0.4] }), subject: "Will the Fed cut rates in December" };
  const b: MarketWithSubject = { market: fakeMarket({ address: "0x2" as `0x${string}`, spotPrices: [0.55, 0.45] }), subject: "Will the Fed cut rates in December" };
  const pairs = findRelatedPairs([a, b]);
  const flag = detectJointIncoherence(pairs[0]!);
  // outcomeCount mismatch means detectJointIncoherence still compares spotPrices[0], which can still flag —
  // the binary guard lives in planArbitragePair itself.
  if (flag?.flagged) {
    const plan = await planArbitragePair(flag, 1, async () => ({ tokensIn: 0.3 }));
    assert.equal(plan, null);
  }
});

// ---------- Layer D: opponents ----------

function trade(outcomeIdx: number, side: "buy" | "sell", t: number): FeedTrade {
  return { outcomeIdx, side, timestampSec: t };
}

test("Layer D detectHerding — insufficient sample size is not detected", () => {
  const trades = [trade(0, "buy", 100), trade(0, "buy", 99)];
  const result = detectHerding(trades);
  assert.equal(result.detected, false);
  assert.match(result.reason, /below the minimum burst size/);
});

test("Layer D detectHerding — null trades (query failed) is not assumed quiet", () => {
  const result = detectHerding(null);
  assert.equal(result.detected, false);
  assert.match(result.reason, /query failed/);
});

test("Layer D detectHerding — concentrated burst is detected with correct direction", () => {
  const trades = [trade(1, "buy", 105), trade(1, "buy", 104), trade(1, "buy", 103), trade(1, "buy", 102), trade(1, "buy", 101), trade(0, "buy", 100)];
  const result = detectHerding(trades);
  assert.equal(result.detected, true);
  assert.equal(result.direction, 1);
});

test("Layer D detectHerding — mixed-direction trades are not herding", () => {
  const trades = [trade(0, "buy", 105), trade(1, "buy", 104), trade(0, "buy", 103), trade(1, "buy", 102), trade(0, "buy", 101), trade(1, "buy", 100)];
  const result = detectHerding(trades);
  assert.equal(result.detected, false);
});

test("Layer D corroboratesFade — only true when herding is on the OPPOSITE outcome from our candidate", () => {
  const herdingOnOne: ReturnType<typeof detectHerding> = { detected: true, direction: 1, burstFraction: 1, sampleSize: 5, reason: "" };
  assert.equal(corroboratesFade(herdingOnOne, 0), true); // our candidate buys outcome 0, herd buys 1 — corroborates
  assert.equal(corroboratesFade(herdingOnOne, 1), false); // herd buying the SAME outcome we'd buy — not a fade, not corroboration

  const noHerding: ReturnType<typeof detectHerding> = { detected: false, direction: null, burstFraction: null, sampleSize: 0, reason: "" };
  assert.equal(corroboratesFade(noHerding, 0), false);
});

test("Layer D applyCorroborationBump — bumps confidence only when corroborating, capped at 1", () => {
  const herding: ReturnType<typeof detectHerding> = { detected: true, direction: 1, burstFraction: 1, sampleSize: 5, reason: "" };
  assert.ok(applyCorroborationBump(0.5, herding, 0) > 0.5);
  assert.equal(applyCorroborationBump(0.5, herding, 1), 0.5); // not corroborating — unchanged
  assert.equal(applyCorroborationBump(0.95, herding, 0), 1); // capped
});
