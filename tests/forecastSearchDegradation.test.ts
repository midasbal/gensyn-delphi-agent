/**
 * Fix 2, part (b) pinning test (pre-launch live testing found "LLM
 * configured but call/parse failed" under search-on, unpaced load).
 *
 * Confirms a real, already-true property of the code (not a new behavior
 * added by this fix): a Tavily failure/timeout inside forecast.ts's search
 * step degrades to a "no evidence available" forecast — it does NOT fail
 * the whole forecastProbability() call. search() (searchProvider.ts) is
 * built on fetchJsonWithTimeout (src/util/fetchJson.ts), which resolves to
 * null on ANY failure rather than rejecting, so a Tavily error is
 * structurally indistinguishable, downstream, from "search returned zero
 * results" — both fall through to the same "none available" branch and the
 * LLM call proceeds normally on the base rate.
 *
 * SEARCH_API_KEY must be set before forecast.ts (transitively config/
 * index.ts) evaluates — via a dynamic import, same reasoning as
 * tests/sportsOdds.test.ts's header comment (a static import is hoisted
 * and would lose this race). GROQ_API_KEY is expected to already be set in
 * the ambient .env for this project (used throughout the test suite's
 * other live-adjacent checks); this test does not depend on its exact
 * value, only that isLLMConfigured() is true.
 *
 * CONDITIONAL_SEARCH_ENABLED=false, deliberately: these tests predate and
 * specifically target the SIMPLE "search unconditionally, then one
 * forecast call" path forecast.ts still uses when conditional search is
 * off — not the newer two-stage gate (see tests/forecastConditionalSearch
 * .test.ts for that). Without forcing this false, the conditional-search
 * default (on) would mean stage 2 often never fires at all for this
 * file's mocked confidence/price values, and these tests would pass
 * vacuously (sourcesUsed==0 because search was never reached, not because
 * it degraded) rather than actually exercising graceful degradation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { NormalizedMarket } from "../src/markets/types.js";
import type { StructuredResolution } from "../src/signals/forecasting/types.js";

process.env.SEARCH_API_KEY = "test-search-key";
process.env.CONDITIONAL_SEARCH_ENABLED = "false";
const { forecastProbability } = await import("../src/signals/forecasting/forecast.js");
const { isSearchConfigured } = await import("../src/signals/forecasting/searchProvider.js");
const { isLLMConfigured } = await import("../src/signals/forecasting/llmClient.js");

function fakeMarket(overrides: Partial<NormalizedMarket>): NormalizedMarket {
  const resolvesAt = overrides.resolvesAt ?? new Date(Date.now() + 5 * 86_400_000);
  return {
    address: "0x00000000000000000000000000000000000f1x" as `0x${string}`,
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

const VALID_GROQ_COMPLETION = {
  choices: [
    {
      message: {
        content: JSON.stringify({
          baseRate: 0.4,
          outcomes: [
            { label: "Yes", probability: 0.4, confidence: 0.5 },
            { label: "No", probability: 0.6, confidence: 0.5 },
          ],
          reasoning: "Base rate only, no evidence available.",
          keyDrivers: [],
          resolutionRisk: "low",
          evidenceQuality: "none",
        }),
      },
    },
  ],
  usage: { total_tokens: 900 },
};

test("preconditions: LLM and search are both configured for this test", () => {
  assert.equal(isLLMConfigured(), true, "expected GROQ_API_KEY to be set in the ambient .env for this test suite");
  assert.equal(isSearchConfigured(), true);
});

test("forecast.ts — a Tavily network failure degrades to a no-evidence forecast, does not fail the call", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("tavily.com")) throw new Error("simulated Tavily network failure");
    if (String(url).includes("groq.com")) return new Response(JSON.stringify(VALID_GROQ_COMPLETION), { status: 200 });
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;

  try {
    const market = fakeMarket({ address: "0x00000000000000000000000000000000000f01" as `0x${string}` });
    const result = await forecastProbability(market, FAKE_STRUCTURED);
    assert.ok(result, "expected a real forecast result despite the search failure");
    assert.equal(result!.outcomes.length, 2);
    assert.equal(result!.outcomes[0]!.probability, 0.4);
    assert.equal(result!.outcomes[1]!.probability, 0.6);
    assert.equal(result!.sourcesUsed.length, 0, "no sources should be attached when search failed");
  } finally {
    globalThis.fetch = original;
  }
});

test("forecast.ts — Tavily returning zero results (not a failure) reaches the identical no-evidence branch", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("tavily.com")) return new Response(JSON.stringify({ results: [] }), { status: 200 });
    if (String(url).includes("groq.com")) return new Response(JSON.stringify(VALID_GROQ_COMPLETION), { status: 200 });
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;

  try {
    const market = fakeMarket({ address: "0x00000000000000000000000000000000000f02" as `0x${string}` });
    const result = await forecastProbability(market, FAKE_STRUCTURED);
    assert.ok(result, "expected a real forecast result when search legitimately found nothing");
    assert.equal(result!.outcomes[0]!.probability, 0.4);
  } finally {
    globalThis.fetch = original;
  }
});

test("forecast.ts — Fix 2 part (c): evidence is actually trimmed to 2 items / 200 chars before it reaches the prompt", async () => {
  const original = globalThis.fetch;
  let capturedPromptBody: string | null = null;
  const longSnippet = "x".repeat(1000);
  const fiveResults = Array.from({ length: 5 }, (_, i) => ({ title: `Source ${i}`, content: longSnippet, url: `https://example.test/${i}` }));

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("tavily.com")) return new Response(JSON.stringify({ results: fiveResults }), { status: 200 });
    if (String(url).includes("groq.com")) {
      capturedPromptBody = String(init?.body ?? "");
      return new Response(JSON.stringify(VALID_GROQ_COMPLETION), { status: 200 });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;

  try {
    const market = fakeMarket({ address: "0x00000000000000000000000000000000000f03" as `0x${string}` });
    const result = await forecastProbability(market, FAKE_STRUCTURED);
    assert.ok(result);
    // Only the top MAX_EVIDENCE_ITEMS (2) sources should be attached, not all 5 Tavily returned.
    assert.equal(result!.sourcesUsed.length, 2, `expected exactly 2 sources (trimmed), got ${result!.sourcesUsed.length}`);

    assert.ok(capturedPromptBody, "expected to capture the actual request body sent to Groq");
    const parsedBody = JSON.parse(capturedPromptBody!) as { messages: Array<{ content: string }> };
    const userMessage = parsedBody.messages.find((m) => m.content.includes("EVIDENCE"))!.content;
    // "x".repeat(1000) trimmed to 200 chars per snippet — a full untrimmed 1000-char run of x's must NOT appear.
    assert.ok(!userMessage.includes("x".repeat(1000)), "the full untrimmed 1000-char snippet leaked into the prompt");
    assert.ok(userMessage.includes("x".repeat(200)), "expected a 200-char trimmed snippet to be present");
    // Only 2 of the 5 "Source N" titles should appear in the evidence block (top-2 trim).
    const sourceMentions = [...userMessage.matchAll(/Source \d/g)].length;
    assert.equal(sourceMentions, 2, `expected exactly 2 evidence items in the prompt, found ${sourceMentions}`);
  } finally {
    globalThis.fetch = original;
  }
});
