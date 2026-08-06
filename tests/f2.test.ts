import { test } from "node:test";
import assert from "node:assert/strict";
import { recordTokenUsage, tokensUsedInLast24h, tokensUsedInWindow, remainingBudget, hasBudgetFor, resetTokenBudget, throttleForRateLimit, exportUsageLog, importUsageLog } from "../src/signals/forecasting/tokenBudget.js";
import { rankForecastCandidates, runForecastGovernor, ESTIMATED_TOKENS_PER_FORECAST, type ForecastCandidate } from "../src/signals/forecastGovernor.js";
import { forecastBudget } from "../src/config/index.js";
import type { NormalizedMarket } from "../src/markets/types.js";
import type { StructuredResolution } from "../src/signals/forecasting/types.js";

function fakeMarket(overrides: Partial<NormalizedMarket>): NormalizedMarket {
  const resolvesAt = overrides.resolvesAt ?? new Date(Date.now() + 5 * 86_400_000);
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

const FAKE_STRUCTURED: StructuredResolution = {
  subject: "X",
  condition: "X happens",
  comparatorOrThreshold: null,
  sourceOfTruth: null,
  resolutionTime: null,
  structuredByLLM: false,
};

// ---------- tokenBudget ----------

test("tokenBudget — tracks usage within the rolling 24h window", () => {
  resetTokenBudget();
  const now = 1_000_000_000_000;
  recordTokenUsage(1000, now);
  recordTokenUsage(2000, now + 1000);
  assert.equal(tokensUsedInLast24h(now + 2000), 3000);
});

test("tokenBudget — prunes entries older than 24h", () => {
  resetTokenBudget();
  const now = 1_000_000_000_000;
  const DAY = 24 * 60 * 60 * 1000;
  recordTokenUsage(5000, now);
  assert.equal(tokensUsedInLast24h(now + DAY + 1), 0);
});

test("tokenBudget — remainingBudget and hasBudgetFor reflect the configured daily budget", () => {
  resetTokenBudget();
  const now = 2_000_000_000_000;
  recordTokenUsage(forecastBudget.dailyTokenBudget - 100, now);
  assert.equal(remainingBudget(now), 100);
  assert.equal(hasBudgetFor(50, now), true);
  assert.equal(hasBudgetFor(200, now), false);
});

test("tokenBudget — zero/negative usage is a no-op", () => {
  resetTokenBudget();
  const now = 3_000_000_000_000;
  recordTokenUsage(0, now);
  recordTokenUsage(-50, now);
  assert.equal(tokensUsedInLast24h(now), 0);
});

// ---------- forecastGovernor ranking ----------

test("rankForecastCandidates — never-forecast markets rank above recently-forecast ones", () => {
  const now = Date.now();
  const never: ForecastCandidate = { market: fakeMarket({ address: "0x1" as `0x${string}` }), structured: FAKE_STRUCTURED, longTail: false, positionHeld: false, lastForecastAtMs: null };
  const recent: ForecastCandidate = { market: fakeMarket({ address: "0x2" as `0x${string}` }), structured: FAKE_STRUCTURED, longTail: false, positionHeld: false, lastForecastAtMs: now - 1000 };
  const ranked = rankForecastCandidates([recent, never], now);
  assert.equal(ranked[0]!.market.address, "0x1");
});

test("rankForecastCandidates — long-tail markets outrank non-long-tail, all else equal", () => {
  const now = Date.now();
  const longTail: ForecastCandidate = { market: fakeMarket({ address: "0x1" as `0x${string}` }), structured: FAKE_STRUCTURED, longTail: true, positionHeld: false, lastForecastAtMs: now };
  const notLongTail: ForecastCandidate = { market: fakeMarket({ address: "0x2" as `0x${string}` }), structured: FAKE_STRUCTURED, longTail: false, positionHeld: false, lastForecastAtMs: now };
  const ranked = rankForecastCandidates([notLongTail, longTail], now);
  assert.equal(ranked[0]!.market.address, "0x1");
});

test("rankForecastCandidates — position held bumps priority", () => {
  const now = Date.now();
  const held: ForecastCandidate = { market: fakeMarket({ address: "0x1" as `0x${string}` }), structured: FAKE_STRUCTURED, longTail: false, positionHeld: true, lastForecastAtMs: now };
  const notHeld: ForecastCandidate = { market: fakeMarket({ address: "0x2" as `0x${string}` }), structured: FAKE_STRUCTURED, longTail: false, positionHeld: false, lastForecastAtMs: now };
  const ranked = rankForecastCandidates([notHeld, held], now);
  assert.equal(ranked[0]!.market.address, "0x1");
});

// ---------- runForecastGovernor budget enforcement ----------

test("runForecastGovernor — forecasts top-ranked candidates and defers the rest once budget runs out", async () => {
  resetTokenBudget();
  const now = Date.now();
  // Leave room for exactly 2 forecasts at ESTIMATED_TOKENS_PER_FORECAST each.
  recordTokenUsage(forecastBudget.dailyTokenBudget - ESTIMATED_TOKENS_PER_FORECAST * 2, now);

  const candidates: ForecastCandidate[] = [1, 2, 3, 4].map((i) => ({
    market: fakeMarket({ address: (`0x${i}`).padEnd(42, "0") as `0x${string}` }),
    structured: FAKE_STRUCTURED,
    longTail: i === 1, // market 1 ranks first (long-tail)
    positionHeld: false,
    lastForecastAtMs: now - i * 1000, // otherwise ties broken by recency (market 4 least recent = 2nd priority)
  }));

  let callCount = 0;
  const fakeForecast = async () => {
    callCount++;
    recordTokenUsage(ESTIMATED_TOKENS_PER_FORECAST); // simulate real forecastProbability's own token recording
    return { outcomes: [{ probability: 0.5, confidence: 0.5 }, { probability: 0.5, confidence: 0.5 }], rationale: "test", sourcesUsed: [] };
  };

  const outcomes = await runForecastGovernor(candidates, fakeForecast);
  const forecasted = outcomes.filter((o) => !o.deferred);
  const deferred = outcomes.filter((o) => o.deferred);

  assert.equal(callCount, 2);
  assert.equal(forecasted.length, 2);
  assert.equal(deferred.length, 2);
  assert.ok(deferred.every((o) => o.result === null));
});

test("runForecastGovernor — never calls the forecast function when there's no budget at all", async () => {
  resetTokenBudget();
  const now = Date.now();
  recordTokenUsage(forecastBudget.dailyTokenBudget, now);

  const candidates: ForecastCandidate[] = [{ market: fakeMarket({}), structured: FAKE_STRUCTURED, longTail: true, positionHeld: false, lastForecastAtMs: null }];
  let called = false;
  const outcomes = await runForecastGovernor(candidates, async () => {
    called = true;
    return null;
  });

  assert.equal(called, false);
  assert.equal(outcomes[0]!.deferred, true);
});

// ---------- per-minute rate limiter (Phase 5 carry-forward correction) ----------

test("throttleForRateLimit — does not sleep when well under the per-minute limit", async () => {
  resetTokenBudget();
  let sleepCalls = 0;
  const fakeSleep = async () => {
    sleepCalls++;
  };
  await throttleForRateLimit(900, () => 5_000_000_000, fakeSleep);
  assert.equal(sleepCalls, 0);
});

test("throttleForRateLimit — sleeps (polls) while the trailing 1-minute window is over budget, then proceeds once it ages out", async () => {
  resetTokenBudget();
  let simulatedNow = 10_000_000_000;
  const nowMs = () => simulatedNow;
  recordTokenUsage(11_000, simulatedNow); // near the 12k/min real cap — with 80% margin (9600), this alone already exceeds it

  let sleepCalls = 0;
  const fakeSleep = async (ms: number) => {
    sleepCalls++;
    simulatedNow += ms;
    if (sleepCalls > 5) simulatedNow += 61_000; // force the old usage to age out of the 1-minute window so the test terminates
  };

  await throttleForRateLimit(500, nowMs, fakeSleep);
  assert.ok(sleepCalls > 0);
  assert.ok(tokensUsedInWindow(60_000, simulatedNow) < 11_000); // the old entry aged out
});

test("tokensUsedInWindow — only counts entries inside the requested window", () => {
  resetTokenBudget();
  const now = 20_000_000_000;
  recordTokenUsage(1000, now - 30_000); // inside 1min window
  recordTokenUsage(2000, now - 90_000); // outside 1min window, inside 24h
  assert.equal(tokensUsedInWindow(60_000, now), 1000);
  assert.equal(tokensUsedInWindow(24 * 60 * 60 * 1000, now), 3000);
});

// ---------- persistence round-trip (export/import) ----------

test("exportUsageLog/importUsageLog — round-trips usage so a restart doesn't lose the window", () => {
  resetTokenBudget();
  const now = 30_000_000_000;
  recordTokenUsage(1234, now);
  recordTokenUsage(5678, now + 1000);
  const exported = exportUsageLog();

  resetTokenBudget();
  assert.equal(tokensUsedInLast24h(now + 2000), 0); // confirm reset actually cleared it

  importUsageLog(exported, now + 2000);
  assert.equal(tokensUsedInLast24h(now + 2000), 1234 + 5678);
});
