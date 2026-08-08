/**
 * Fix 1 pinning tests (live-testing bug: a CFL over/under market returned
 * no-match even though CFL is a covered league in The Odds API's feed).
 * Root cause had two parts:
 *   1. "americanfootball_cfl" was missing from SPORT_KEYS — a covered
 *      league was simply never queried.
 *   2. Even once queried, the reported market is an over/under (totals)
 *      question, not a two-way "who wins" moneyline — h2h odds can't
 *      answer that, so it must STILL correctly return no-match (now via a
 *      numeric-condition guard), not get silently, wrongly matched with a
 *      "which team wins" probability standing in for a different question.
 *
 * Each test file under `node:test`/tsx runs in its own process (verified
 * empirically — env vars set in one test file do not leak into another),
 * so setting ODDS_API_KEY here is safe and doesn't affect any other test
 * file's view of config/index.ts. It must be set via a DYNAMIC import,
 * though, not a static one: static `import` specifiers are hoisted and
 * evaluate before any of this file's own top-level statements run, so a
 * plain `process.env.ODDS_API_KEY = ...` placed textually above a static
 * `import { sportsOddsAdapter } from ...` still loses the race — config/
 * index.ts would already have captured `undefined` by the time the
 * assignment runs. A dynamic `import()` call is a real expression, not
 * hoisted, so it only evaluates (and only then does config/index.ts read
 * process.env) once actually reached.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { NormalizedMarket } from "../src/markets/types.js";

process.env.ODDS_API_KEY = "test-odds-key";
const { sportsOddsAdapter } = await import("../src/signals/consensus/sportsOdds.js");

function fakeMarket(overrides: Partial<NormalizedMarket>): NormalizedMarket {
  const resolvesAt = overrides.resolvesAt ?? new Date("2026-08-15T00:00:00.000Z");
  return {
    address: "0x0000000000000000000000000000000000dead" as `0x${string}`,
    appMarketId: "fake",
    marketUrl: "https://example.invalid",
    status: "open",
    category: "sports",
    domain: "sports",
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

const CFL_H2H_EVENT = {
  id: "evt1",
  commence_time: "2026-08-15T00:00:00.000Z",
  home_team: "Hamilton Tiger-Cats",
  away_team: "BC Lions",
  bookmakers: [
    {
      key: "draftkings",
      markets: [
        {
          key: "h2h",
          outcomes: [
            { name: "Hamilton Tiger-Cats", price: 1.8 }, // implied ~0.5556
            { name: "BC Lions", price: 2.1 }, // implied ~0.4762
          ],
        },
      ],
    },
  ],
};

async function withStubbedFetch<T>(stub: typeof fetch, fn: () => Promise<T>): Promise<{ result: T; requestedUrls: string[] }> {
  const requestedUrls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requestedUrls.push(String(url));
    return stub(url, init);
  }) as typeof fetch;
  try {
    const result = await fn();
    return { result, requestedUrls };
  } finally {
    globalThis.fetch = original;
  }
}

function emptyEventsResponse(): Response {
  return new Response(JSON.stringify([]), { status: 200 });
}

test("sportsOdds — CFL is now actually queried (the root-cause bug: a covered league was missing from SPORT_KEYS)", async () => {
  const market = fakeMarket({ question: "Will the Hamilton Tiger-Cats beat the BC Lions?" });
  const { requestedUrls } = await withStubbedFetch(
    (async () => emptyEventsResponse()) as typeof fetch,
    () => sportsOddsAdapter.match(market)
  );
  const cflRequests = requestedUrls.filter((u) => u.includes("americanfootball_cfl"));
  assert.equal(cflRequests.length, 1, `expected exactly one CFL request among: ${JSON.stringify(requestedUrls)}`);
});

test("sportsOdds — a genuine CFL h2h/moneyline market in a now-covered league matches correctly", async () => {
  const market = fakeMarket({ question: "Will the Hamilton Tiger-Cats beat the BC Lions?" });
  const { result } = await withStubbedFetch(
    (async (url: string) => (String(url).includes("americanfootball_cfl") ? new Response(JSON.stringify([CFL_H2H_EVENT]), { status: 200 }) : emptyEventsResponse())) as typeof fetch,
    () => sportsOddsAdapter.match(market)
  );
  assert.ok(result, "expected a match for a genuine, now-covered-league h2h market");
  assert.equal(result!.matchQuality, "high");
  assert.equal(result!.sourceName, "the-odds-api");
  // no-vig implied probability for the home side: (1/1.8) / (1/1.8 + 1/2.1)
  const expected = 1 / 1.8 / (1 / 1.8 + 1 / 2.1);
  assert.ok(Math.abs(result!.outcomes[0]!.probability! - expected) < 1e-9, `expected probability ~${expected}, got ${result!.outcomes[0]!.probability}`);
});

test("sportsOdds — the reported CFL OVER/UNDER market still correctly returns no-match (h2h odds can't answer a totals question), and skips the API call entirely", async () => {
  const market = fakeMarket({ question: "Will the Hamilton Tiger-Cats and BC Lions combine for 56+ points?" });
  const { result, requestedUrls } = await withStubbedFetch(
    // Even if this were reached and returned the same CFL event as the h2h test above, it must NOT match —
    // team names would overlap and the date would match, so only the numeric-condition guard prevents a
    // wrong "who wins" probability being silently attached to a totals question.
    (async () => new Response(JSON.stringify([CFL_H2H_EVENT]), { status: 200 })) as typeof fetch,
    () => sportsOddsAdapter.match(market)
  );
  assert.equal(result, null);
  assert.deepEqual(requestedUrls, [], "the numeric-condition guard should short-circuit before spending any API budget");
});

test("sportsOdds — a genuinely uncovered league (not in SPORT_KEYS) still correctly returns no-match", async () => {
  // A league The Odds API doesn't cover at all (or that this project deliberately hasn't added yet) —
  // every sport-key query returns empty, so no team-name/date matching ever gets a chance to fire.
  const market = fakeMarket({ question: "Will Team Liquid beat Gen.G in the LPL final?" });
  const { result, requestedUrls } = await withStubbedFetch((async () => emptyEventsResponse()) as typeof fetch, () => sportsOddsAdapter.match(market));
  assert.equal(result, null);
  assert.ok(requestedUrls.every((u) => !u.includes("lpl") && !u.includes("esports")), "must never query a made-up sport key for an uncovered league");
});

