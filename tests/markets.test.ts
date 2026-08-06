/**
 * Unit tests for markets/parseResolution.ts and markets/classify.ts.
 *
 * The parseResolution fixtures below are real questions captured live from
 * competition-testnet on 2026-08-06 (open markets, competition still active
 * ahead of the Aug 10 reset). Frozen as fixtures rather than fetched live so
 * this suite is deterministic and doesn't need network/API key access to run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseResolution } from "../src/markets/parseResolution.js";
import { classifyDomain } from "../src/markets/classify.js";

const FIXTURES: Array<{
  question: string;
  resolvesAt: string;
  expectCriteria: string;
  expectTimingPhrase: string | null;
  expectTimingDateHint: string | null; // ISO date, UTC midnight
  expectTimingMatches: boolean | null;
}> = [
  {
    question: "Will U.S. initial jobless claims for the week ending August 1, 2026 come in at 210,000 or more?",
    resolvesAt: "2026-08-06T21:00:00.000Z",
    expectCriteria: "Will U.S. initial jobless claims for the week ending come in at 210,000 or more",
    expectTimingPhrase: "August 1, 2026",
    expectTimingDateHint: "2026-08-01T00:00:00.000Z",
    expectTimingMatches: false,
  },
  {
    question: "Will Banxico leave its policy interest rate unchanged at its Aug 6, 2026 Governing Board decision?",
    resolvesAt: "2026-08-06T21:00:00.000Z",
    expectCriteria: "Will Banxico leave its policy interest rate unchanged Governing Board decision",
    expectTimingPhrase: "at its Aug 6, 2026",
    expectTimingDateHint: "2026-08-06T00:00:00.000Z",
    expectTimingMatches: true,
  },
  {
    question: "Will Google release a model called Gemini 3.5 Pro (or higher) by 11:59 PM ET on August 6, 2026?",
    resolvesAt: "2026-08-06T21:00:00.000Z",
    expectCriteria: "Will Google release a model called Gemini 3.5 Pro (or higher) by 11:59 PM ET",
    expectTimingPhrase: "on August 6, 2026",
    expectTimingDateHint: "2026-08-06T00:00:00.000Z",
    expectTimingMatches: true,
  },
  {
    question: "Will SpaceX launch the Dragon CRS-35 cargo mission by 11:59 PM ET on August 6, 2026?",
    resolvesAt: "2026-08-06T21:00:00.000Z",
    expectCriteria: "Will SpaceX launch the Dragon CRS-35 cargo mission by 11:59 PM ET",
    expectTimingPhrase: "on August 6, 2026",
    expectTimingDateHint: "2026-08-06T00:00:00.000Z",
    expectTimingMatches: true,
  },
  {
    question: "Leagues Cup Aug 5, 2026 (local kickoff): did both Inter Miami and Atlético San Luis score in regulation?",
    resolvesAt: "2026-08-06T21:00:00.000Z",
    expectCriteria: "Leagues Cup: did both Inter Miami and Atlético San Luis score in regulation",
    expectTimingPhrase: "Aug 5, 2026 (local kickoff)",
    expectTimingDateHint: "2026-08-05T00:00:00.000Z",
    expectTimingMatches: false,
  },
  {
    question: "Will Jeanine Pirro's departure as U.S. Attorney for D.C. be announced by 11:59 PM ET on Aug 6, 2026?",
    resolvesAt: "2026-08-06T21:00:00.000Z",
    expectCriteria: "Will Jeanine Pirro's departure as U.S. Attorney for D.C. be announced by 11:59 PM ET",
    expectTimingPhrase: "on Aug 6, 2026",
    expectTimingDateHint: "2026-08-06T00:00:00.000Z",
    expectTimingMatches: true,
  },
  {
    question: "Was the high temperature at Los Angeles International Airport (KLAX) above 82°F on Aug 5, 2026 (Pacific time)?",
    resolvesAt: "2026-08-06T21:00:00.000Z",
    expectCriteria: "Was the high temperature at Los Angeles International Airport (KLAX) above 82°F",
    expectTimingPhrase: "on Aug 5, 2026 (Pacific time)",
    expectTimingDateHint: "2026-08-05T00:00:00.000Z",
    expectTimingMatches: false,
  },
  {
    question: "Will Jason Day win the 2026 Wyndham Championship?",
    resolvesAt: "2026-08-09T00:00:00.000Z",
    expectCriteria: "Will Jason Day win the 2026 Wyndham Championship",
    expectTimingPhrase: null,
    expectTimingDateHint: null,
    expectTimingMatches: null,
  },
  {
    question: "Will Donald Trump post 180–199 times on Truth Social between Aug 4, 2026 at 12:00 pm ET and Aug 11, 2026 at 12:00 pm ET?",
    resolvesAt: "2026-08-11T16:00:00.000Z",
    expectCriteria: "Will Donald Trump post 180–199 times on Truth Social",
    expectTimingPhrase: "between Aug 4, 2026 at 12:00 pm ET and Aug 11, 2026 at 12:00 pm ET",
    expectTimingDateHint: "2026-08-04T00:00:00.000Z",
    expectTimingMatches: false,
  },
  {
    question: "Will ZGGG (Guangzhou Baiyun) max temperature on 7 Aug 2026 (CST, UTC+8) be ≥39.0°C but <40.0°C?",
    resolvesAt: "2026-08-07T12:00:00.000Z",
    expectCriteria: "Will ZGGG (Guangzhou Baiyun) max temperature be ≥39.0°C but <40.0°C",
    expectTimingPhrase: "on 7 Aug 2026 (CST, UTC+8)",
    expectTimingDateHint: "2026-08-07T00:00:00.000Z",
    expectTimingMatches: true,
  },
];

test("parseResolution — live market set fixtures", async (t) => {
  for (const fx of FIXTURES) {
    await t.test(fx.question.slice(0, 60), () => {
      const resolvesAt = new Date(fx.resolvesAt);
      const result = parseResolution(fx.question, resolvesAt);

      assert.equal(result.criteria, fx.expectCriteria);
      assert.equal(result.timingPhrase, fx.expectTimingPhrase);
      assert.equal(
        result.timingDateHint ? result.timingDateHint.toISOString() : null,
        fx.expectTimingDateHint
      );
      assert.equal(result.timingMatchesResolvesAt, fx.expectTimingMatches);
      // Invariant: criteria must never be empty, and must never contain a "?"
      // (the timing clause removal must not eat the whole question).
      assert.ok(result.criteria.length > 0);
      assert.ok(!result.criteria.includes("?"));
    });
  }
});

test("parseResolution — no date in question at all", () => {
  const result = parseResolution("Will the coin land heads?", null);
  assert.equal(result.criteria, "Will the coin land heads");
  assert.equal(result.timingPhrase, null);
  assert.equal(result.timingDateHint, null);
  assert.equal(result.timingMatchesResolvesAt, null);
});

test("parseResolution — resolvesAt missing, date present: timingMatchesResolvesAt is null not false", () => {
  const result = parseResolution("Will X happen by Aug 6, 2026?", null);
  assert.equal(result.timingDateHint?.toISOString(), "2026-08-06T00:00:00.000Z");
  assert.equal(result.timingMatchesResolvesAt, null);
});

test("classifyDomain — direct category mapping takes priority over keywords", () => {
  assert.equal(classifyDomain("sports", "Will BTC hit $100k?"), "sports");
  assert.equal(classifyDomain("crypto", "Will the president resign?"), "crypto");
});

test("classifyDomain — falls back to keyword rules when category is empty/miscellaneous", () => {
  assert.equal(classifyDomain("", "Was the temperature above 82°F on Aug 5?"), "weather");
  assert.equal(classifyDomain("miscellaneous", "Will Google release a new model by Friday?"), "tech");
  assert.equal(classifyDomain("miscellaneous", "Will BTC close above $100k?"), "crypto");
});

test("classifyDomain — unmatched category and unmatched keywords fall through to miscellaneous", () => {
  assert.equal(classifyDomain("", "Will this happen?"), "miscellaneous");
});
