import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveThinMarketFill, type ThinQuoteFn } from "../src/execution/thinMarketFill.js";

const MARKET = "0x0000000000000000000000000000000000dead" as `0x${string}`;

/** Simulates an LMSR-ish quote: cost per share increases with size (price impact), capped so a huge order effectively reverts. */
function makeQuoteFn(basePrice: number, impactPerShare: number, maxShares: number): ThinQuoteFn {
  return async (_market, _outcome, shares) => {
    if (shares > maxShares) throw new Error("simulated revert: exceeds depth");
    const avgPrice = basePrice + impactPerShare * (shares / 2); // linear impact, averaged
    return { tokensIn: avgPrice * shares };
  };
}

test("resolveThinMarketFill — accepts desired size immediately when it already fits slippage and edge", async () => {
  const quoteFn = makeQuoteFn(0.5, 0.001, 1000);
  const result = await resolveThinMarketFill(MARKET, 0, 1, 0.5, 0.7, 0.05, 0.02, 0.01, 0.1, quoteFn);
  assert.ok(result);
  assert.equal(result!.finalShares, 1);
  assert.equal(result!.steppedBelowSoftFloor, false);
});

test("resolveThinMarketFill — steps down below the soft floor when the market is thin, recomputing edge at actual price", async () => {
  // Depth caps out very fast (maxShares=0.3): desired size of 10 must step down several times.
  const quoteFn = makeQuoteFn(0.5, 0.01, 0.3);
  const result = await resolveThinMarketFill(MARKET, 0, 10, 0.5, 0.7, 0.05, 0.02, 0.01, 0.5, quoteFn);
  assert.ok(result);
  assert.ok(result!.finalShares < 10);
  assert.ok(result!.finalShares <= 0.3);
  assert.ok(result!.steppedBelowSoftFloor); // soft floor is 0.5, we stepped well below it
  assert.ok(result!.recomputedEdge >= 0.05);
});

test("resolveThinMarketFill — never returns a size below the hard floor", async () => {
  // Depth is essentially zero — every size above a tiny amount reverts.
  const quoteFn = makeQuoteFn(0.5, 0, 0.005);
  const result = await resolveThinMarketFill(MARKET, 0, 10, 0.5, 0.7, 0.05, 0.02, 0.01, 0.5, quoteFn);
  assert.equal(result, null); // 0.005 < hardMinShares (0.01) — must skip, not fill below the hard floor
});

test("resolveThinMarketFill — skips when the recomputed edge at the actual fill price no longer clears the threshold", async () => {
  // Price impact is so steep that even a stepped-down fill's effective price erodes the edge below threshold.
  const quoteFn = makeQuoteFn(0.5, 0.5, 1000); // huge impact per share
  const result = await resolveThinMarketFill(MARKET, 0, 10, 0.5, 0.55, 0.05, 0.02, 0.01, 0.5, quoteFn);
  // ourProbability=0.55, basePrice=0.5 → spot edge is only 0.05; any price impact pushes effective price
  // above 0.5, so recomputedEdge < 0.05 at every size — should never clear the threshold.
  assert.equal(result, null);
});

test("resolveThinMarketFill — a quote that always reverts (zero depth) returns null", async () => {
  const quoteFn: ThinQuoteFn = async () => {
    throw new Error("always reverts");
  };
  const result = await resolveThinMarketFill(MARKET, 0, 10, 0.5, 0.7, 0.05, 0.02, 0.01, 0.5, quoteFn);
  assert.equal(result, null);
});
