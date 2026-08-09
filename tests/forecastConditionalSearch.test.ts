/**
 * Conditional search: a cheap no-search forecast runs first; a second,
 * search-augmented call only fires when it could plausibly change a trade
 * decision — LOW CONFIDENCE (below forecastBudget.forecastSearchConfThreshold)
 * AND a TRADEABLE EDGE vs the market price (>= forecastSearchMinEdge). This
 * pins that gate: no wasted search call when the cheap forecast is already
 * confident or already agrees with the price, a real search call (and its
 * result) only when both conditions hold, graceful fallback to the cheap
 * result if Tavily fails once triggered (with NO wasted second LLM call),
 * and honest token accounting when both calls really do fire.
 *
 * SEARCH_API_KEY/CONDITIONAL_SEARCH_ENABLED must be set before forecast.ts
 * (transitively config/index.ts) evaluates — via dynamic import, same
 * reasoning as tests/sportsOdds.test.ts's header comment (a static import
 * is hoisted and would lose this race). GROQ_API_KEY is expected to
 * already be set in the ambient .env (used throughout this test suite);
 * this test does not depend on its exact value, only that
 * isLLMConfigured() is true. Each test uses its own market address to
 * avoid forecast.ts's internal cache carrying a result over between tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { NormalizedMarket } from "../src/markets/types.js";
import type { StructuredResolution } from "../src/signals/forecasting/types.js";

process.env.SEARCH_API_KEY = "test-search-key";
process.env.CONDITIONAL_SEARCH_ENABLED = "true";
const { forecastProbability } = await import("../src/signals/forecasting/forecast.js");
const { isSearchConfigured } = await import("../src/signals/forecasting/searchProvider.js");
const { isLLMConfigured } = await import("../src/signals/forecasting/llmClient.js");
const { tokensUsedInLast24h } = await import("../src/signals/forecasting/tokenBudget.js");

function fakeMarket(overrides: Partial<NormalizedMarket>): NormalizedMarket {
  const resolvesAt = overrides.resolvesAt ?? new Date(Date.now() + 5 * 86_400_000);
  return {
    address: "0x00000000000000000000000000000000000000" as `0x${string}`,
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

const FAKE_STRUCTURED: StructuredResolution = {
  subject: "X",
  condition: "X happens",
  comparatorOrThreshold: null,
  sourceOfTruth: null,
  resolutionTime: null,
  structuredByLLM: false,
};

function groqCompletion(probabilityYes: number, confidence: number, totalTokens: number) {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            baseRate: probabilityYes,
            outcomes: [
              { label: "Yes", probability: probabilityYes, confidence },
              { label: "No", probability: 1 - probabilityYes, confidence },
            ],
            reasoning: "test forecast",
            keyDrivers: [],
            resolutionRisk: "low",
            evidenceQuality: confidence < 0.5 ? "thin" : "moderate",
          }),
        },
      },
    ],
    usage: { total_tokens: totalTokens },
  };
}

/** Mocks Groq to return `groqResponses` in call order (one per fetch to api.groq.com), and Tavily per `tavilyBehavior`. Returns the list of URLs actually fetched. */
function stubFetch(groqResponses: unknown[], tavilyBehavior: "success" | "empty" | "fail") {
  const requestedUrls: string[] = [];
  let groqCallIndex = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    requestedUrls.push(String(url));
    if (String(url).includes("tavily.com")) {
      if (tavilyBehavior === "fail") throw new Error("simulated Tavily failure");
      if (tavilyBehavior === "empty") return new Response(JSON.stringify({ results: [] }), { status: 200 });
      return new Response(
        JSON.stringify({ results: [{ title: "Evidence A", url: "https://example.test/a", content: "some real evidence" }] }),
        { status: 200 }
      );
    }
    if (String(url).includes("groq.com")) {
      const body = groqResponses[groqCallIndex];
      groqCallIndex++;
      if (!body) throw new Error(`unexpected extra Groq call (index ${groqCallIndex - 1})`);
      return new Response(JSON.stringify(body), { status: 200 });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
  return { requestedUrls, restore: () => (globalThis.fetch = original), groqCallCount: () => groqCallIndex };
}

test("preconditions: LLM and search are both configured, conditional search is on", () => {
  assert.equal(isLLMConfigured(), true, "expected GROQ_API_KEY to be set in the ambient .env for this test suite");
  assert.equal(isSearchConfigured(), true);
});

test("(a) high-confidence no-search forecast -> no search call made", async () => {
  // confidence 0.9 >= default threshold 0.5 -> stage 2 never triggers, regardless of edge.
  const stub = stubFetch([groqCompletion(0.9, 0.9, 900)], "success");
  try {
    const market = fakeMarket({ address: "0x00000000000000000000000000000000000a01" as `0x${string}` });
    const result = await forecastProbability(market, FAKE_STRUCTURED);
    assert.ok(result);
    assert.equal(result!.outcomes[0]!.probability, 0.9);
    assert.ok(!stub.requestedUrls.some((u) => u.includes("tavily.com")), "search must not be called when confidence is already high");
    assert.equal(stub.groqCallCount(), 1, "only the cheap stage-1 call should have fired");
  } finally {
    stub.restore();
  }
});

test("(b) low confidence but no tradeable edge vs price -> no search call", async () => {
  // confidence 0.3 < threshold, but probability 0.5 == market price 0.5 -> edge 0 < default minEdge 0.05.
  const stub = stubFetch([groqCompletion(0.5, 0.3, 900)], "success");
  try {
    const market = fakeMarket({ address: "0x00000000000000000000000000000000000a02" as `0x${string}`, spotPrices: [0.5, 0.5] });
    const result = await forecastProbability(market, FAKE_STRUCTURED);
    assert.ok(result);
    assert.equal(result!.outcomes[0]!.probability, 0.5);
    assert.ok(!stub.requestedUrls.some((u) => u.includes("tavily.com")), "search must not be called when the cheap forecast already agrees with the price");
    assert.equal(stub.groqCallCount(), 1);
  } finally {
    stub.restore();
  }
});

test("(c) low confidence AND tradeable edge -> search call made, its result is used", async () => {
  // Stage 1: confidence 0.3 (low), probability 0.8 vs price 0.5 -> edge 0.3 >= default minEdge 0.05. Triggers stage 2.
  // Stage 2: a DIFFERENT probability (0.75) so we can prove the FINAL result is stage 2's, not stage 1's.
  const stub = stubFetch([groqCompletion(0.8, 0.3, 900), groqCompletion(0.75, 0.7, 1000)], "success");
  try {
    const market = fakeMarket({ address: "0x00000000000000000000000000000000000a03" as `0x${string}`, spotPrices: [0.5, 0.5] });
    const result = await forecastProbability(market, FAKE_STRUCTURED);
    assert.ok(result);
    assert.equal(result!.outcomes[0]!.probability, 0.75, "expected the search-augmented (stage 2) result, not the cheap (stage 1) one");
    assert.equal(result!.outcomes[0]!.confidence, 0.7);
    assert.ok(stub.requestedUrls.some((u) => u.includes("tavily.com")), "search should have been called");
    assert.equal(stub.groqCallCount(), 2, "both the cheap and search-augmented calls should have fired");
    assert.deepEqual(result!.sourcesUsed, ["https://example.test/a"]);
  } finally {
    stub.restore();
  }
});

test("(d) search triggered but Tavily fails -> the no-search forecast is retained, no throw, no wasted second LLM call", async () => {
  const stub = stubFetch([groqCompletion(0.8, 0.3, 900)], "fail");
  try {
    const market = fakeMarket({ address: "0x00000000000000000000000000000000000a04" as `0x${string}`, spotPrices: [0.5, 0.5] });
    const result = await forecastProbability(market, FAKE_STRUCTURED);
    assert.ok(result, "must not throw/return null just because the optional search leg failed");
    assert.equal(result!.outcomes[0]!.probability, 0.8, "expected the cheap (stage-1) result to be kept");
    assert.equal(result!.outcomes[0]!.confidence, 0.3);
    assert.ok(stub.requestedUrls.some((u) => u.includes("tavily.com")), "search should have been attempted");
    assert.equal(stub.groqCallCount(), 1, "a failed search must not waste a second LLM call on a re-forecast with no new evidence");
  } finally {
    stub.restore();
  }
});

test("(e) token accounting counts BOTH calls when the search-augmented stage actually fires", async () => {
  const stub = stubFetch([groqCompletion(0.8, 0.3, 900), groqCompletion(0.75, 0.7, 1000)], "success");
  try {
    const market = fakeMarket({ address: "0x00000000000000000000000000000000000a05" as `0x${string}`, spotPrices: [0.5, 0.5] });
    const before = tokensUsedInLast24h();
    const result = await forecastProbability(market, FAKE_STRUCTURED);
    assert.ok(result);
    const after = tokensUsedInLast24h();
    assert.equal(after - before, 900 + 1000, "both the cheap call's and the search-augmented call's token usage should be recorded");
  } finally {
    stub.restore();
  }
});

test("(e-corollary) when search does NOT fire, only the single cheap call's tokens are recorded", async () => {
  const stub = stubFetch([groqCompletion(0.9, 0.9, 900)], "success");
  try {
    const market = fakeMarket({ address: "0x00000000000000000000000000000000000a06" as `0x${string}` });
    const before = tokensUsedInLast24h();
    const result = await forecastProbability(market, FAKE_STRUCTURED);
    assert.ok(result);
    const after = tokensUsedInLast24h();
    assert.equal(after - before, 900);
  } finally {
    stub.restore();
  }
});

// CONDITIONAL_SEARCH_ENABLED=false's fallback-to-old-behavior path is NOT
// tested in THIS file: config/index.ts's forecastBudget object is computed
// once, at first import, from process.env — by the time any test here
// runs, it's already cached as conditionalSearchEnabled=true (set at the
// top of this file, before any import). Toggling process.env afterward,
// even via a differently-specified dynamic import of forecast.ts, does NOT
// force config/index.ts to re-evaluate (it resolves to the same cached
// module instance either way — only the FIRST import of a given module URL
// in a process runs its top-level code). Testing the disabled fallback
// needs its own process with the flag set before ANY import — that's
// exactly what tests/forecastSearchDegradation.test.ts already does
// (CONDITIONAL_SEARCH_ENABLED=false there, verifying search runs
// unconditionally in a single call), so it's covered there, not duplicated
// here.
