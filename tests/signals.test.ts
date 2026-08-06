import { test } from "node:test";
import assert from "node:assert/strict";
import {
  wordOverlapScore,
  dateProximityScore,
  extractNumericCondition,
  numericConditionsAgree,
  buildSearchQuery,
} from "../src/signals/consensus/textMatch.js";
import { combineSignals } from "../src/signals/combine.js";
import { distributionFromSingleOutcome, isFullyEstimated, estimatedCount } from "../src/signals/types.js";
import type { ConsensusMatch } from "../src/signals/consensus/types.js";
import type { ForecastResult } from "../src/signals/forecasting/types.js";

test("extractNumericCondition — range, gte, gt, plus, currency", () => {
  assert.deepEqual(extractNumericCondition("post 180–199 times"), { type: "range", low: 180, high: 199 });
  assert.deepEqual(extractNumericCondition("210,000 or more"), { type: "gte", value: 210000 });
  assert.deepEqual(extractNumericCondition("above $50,000"), { type: "gt", value: 50000 });
  assert.deepEqual(extractNumericCondition("200+ posts"), { type: "gte", value: 200 });
  assert.deepEqual(extractNumericCondition("≥39.0°C"), { type: "gte", value: 39 });
  assert.equal(extractNumericCondition("no numbers here"), null);
});

test("numericConditionsAgree — agreement, disagreement, and not-comparable", () => {
  assert.equal(numericConditionsAgree({ type: "range", low: 180, high: 199 }, { type: "range", low: 180, high: 199 }), true);
  assert.equal(numericConditionsAgree({ type: "range", low: 180, high: 199 }, { type: "range", low: 80, high: 99 }), false);
  assert.equal(numericConditionsAgree({ type: "gt", value: 50000 }, { type: "gte", value: 50000 }), false);
  assert.equal(numericConditionsAgree(null, { type: "gt", value: 1 }), null);
});

test("wordOverlapScore — identical vs disjoint text", () => {
  assert.equal(wordOverlapScore("Will BTC hit $100k?", "Will BTC hit $100k?"), 1);
  assert.equal(wordOverlapScore("completely unrelated sentence here", "totally different words entirely"), 0);
});

test("dateProximityScore — same day is 1, far apart decays to 0", () => {
  const d = new Date("2026-08-06T00:00:00Z");
  assert.equal(dateProximityScore(d, d), 1);
  assert.equal(dateProximityScore(d, new Date("2026-09-06T00:00:00Z"), 5), 0);
});

test("buildSearchQuery — prefers proper nouns, drops the leading question word", () => {
  const q = buildSearchQuery("Will Donald Trump post 180-199 times on Truth Social?");
  assert.ok(!q.toLowerCase().startsWith("will"));
  assert.ok(q.includes("Donald"));
  assert.ok(q.includes("Trump"));
});

test("buildSearchQuery — falls back to generic keywords when there aren't enough proper nouns", () => {
  const q = buildSearchQuery("was the temperature above eighty degrees today");
  assert.ok(q.length > 0);
});

test("distributionFromSingleOutcome — binary market derives the exact complement", () => {
  const dist = distributionFromSingleOutcome(0, 0.7, 0.8, 2);
  assert.equal(dist[0]!.probability, 0.7);
  assert.equal(dist[0]!.confidence, 0.8);
  assert.ok(Math.abs(dist[1]!.probability! - 0.3) < 1e-9);
  assert.equal(dist[1]!.confidence, 0.8);
  assert.ok(isFullyEstimated(dist));
  assert.equal(estimatedCount(dist), 2);
});

test("distributionFromSingleOutcome — N>2 outcomes only fills the named one, flags the rest as unestimated", () => {
  const dist = distributionFromSingleOutcome(1, 0.4, 0.6, 4);
  assert.equal(dist.length, 4);
  assert.equal(dist[1]!.probability, 0.4);
  assert.equal(dist[0]!.probability, null);
  assert.equal(dist[2]!.probability, null);
  assert.equal(dist[3]!.probability, null);
  assert.equal(isFullyEstimated(dist), false);
  assert.equal(estimatedCount(dist), 1);
});

function makeConsensus(matchQuality: "high" | "medium", outcomes: ReturnType<typeof distributionFromSingleOutcome>): ConsensusMatch {
  return { outcomes, sourceName: "test-source", matchQuality, detail: "test" };
}
function makeForecast(outcomes: ReturnType<typeof distributionFromSingleOutcome>): ForecastResult {
  return { outcomes, rationale: "test", sourcesUsed: [] };
}

test("combineSignals — no consensus, no forecast: null probability on every outcome, no crash", () => {
  const result = combineSignals([0.5, 0.5], null, null);
  assert.equal(result.perOutcome[0]!.probability, null);
  assert.equal(result.perOutcome[1]!.probability, null);
  assert.equal(result.fullyEstimated, false);
  assert.equal(result.singleOutcomeOnly, false);
});

test("combineSignals — high consensus only: combined equals consensus, weight 1, correct per-outcome edge", () => {
  const consensus = makeConsensus("high", distributionFromSingleOutcome(0, 0.7, 0.8, 2));
  const result = combineSignals([0.5, 0.5], consensus, null);
  assert.equal(result.perOutcome[0]!.probability, 0.7);
  assert.ok(Math.abs(result.perOutcome[0]!.edge! - 0.2) < 1e-9);
  assert.ok(Math.abs(result.perOutcome[1]!.probability! - 0.3) < 1e-9);
  assert.ok(Math.abs(result.perOutcome[1]!.edge! - -0.2) < 1e-9);
  assert.ok(result.fullyEstimated);
});

test("combineSignals — high consensus dominates over forecast (weight 0.85 vs 0.15)", () => {
  const consensus = makeConsensus("high", distributionFromSingleOutcome(0, 0.7, 0.8, 2));
  const forecast = makeForecast(distributionFromSingleOutcome(0, 0.4, 0.6, 2));
  const result = combineSignals([0.5, 0.5], consensus, forecast);
  const expected = 0.85 * 0.7 + 0.15 * 0.4;
  assert.ok(Math.abs(result.perOutcome[0]!.probability! - expected) < 1e-9);
});

test("combineSignals — medium consensus weighs far less than high (0.35 vs 0.85) when blended with forecast", () => {
  const highC = makeConsensus("high", distributionFromSingleOutcome(0, 0.7, 0.8, 2));
  const mediumC = makeConsensus("medium", distributionFromSingleOutcome(0, 0.7, 0.5, 2));
  const forecast = makeForecast(distributionFromSingleOutcome(0, 0.4, 0.6, 2));
  const withHigh = combineSignals([0.5, 0.5], highC, forecast);
  const withMedium = combineSignals([0.5, 0.5], mediumC, forecast);
  // Both consensus sources say 0.7, forecast says 0.4 — medium's lower weight pulls the blend further toward forecast.
  assert.ok(withMedium.perOutcome[0]!.probability! < withHigh.perOutcome[0]!.probability!);
});

test("combineSignals — N>2 outcomes with only one estimated: flags singleOutcomeOnly", () => {
  const consensus = makeConsensus("high", distributionFromSingleOutcome(1, 0.4, 0.7, 4));
  const result = combineSignals([0.25, 0.25, 0.25, 0.25], consensus, null);
  assert.equal(result.singleOutcomeOnly, true);
  assert.equal(result.fullyEstimated, false);
  assert.equal(result.perOutcome[1]!.probability, 0.4);
  assert.equal(result.perOutcome[0]!.probability, null);
  assert.ok(result.note.includes("FLAGGED"));
});
