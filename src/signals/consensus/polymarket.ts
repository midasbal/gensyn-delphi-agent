/**
 * Polymarket consensus adapter.
 *
 * Uses the public Gamma API (`gamma-api.polymarket.com`) — no API key, no
 * auth. Verified live 2026-08-06:
 *   - `/public-search?q=<text>&limit_per_type=N` — free-text search across
 *     events, returns matching events each with their nested sub-`markets`.
 *     No deprecation header observed on this endpoint.
 *   - `/markets` (the plain list endpoint) responds with `deprecation: true`
 *     and a `sunset` date of 2026-05-01 — already past as of this run — plus
 *     a `warning: 299 - "use /markets/keyset"` header. We don't use it;
 *     search is what we need anyway.
 *   - No published rate-limit headers were observed; Cloudflare-fronted with
 *     5-minute edge caching. Self-throttled to one request per market.
 *
 * The search query is built by `buildSearchQuery` (textMatch.ts), NOT by
 * passing the question straight through — confirmed live that the full
 * question (with numbers) or a generic keyword list can return a completely
 * unrelated, year-old set of events, while a short proper-noun query returns
 * the right current events. See that function's doc for the reasoning.
 *
 * MATCH IS A HARD AND-GATE, not a blended score (per project requirement:
 * matchQuality must be a hard gate, not a label). A candidate sub-market is
 * only accepted — as "high" quality — if ALL of these hold:
 *   1. subject: word-overlap score against the event+sub-market text clears
 *      a high bar
 *   2. threshold/condition: either NEITHER side states a numeric condition,
 *      or BOTH do and they agree (a mismatch, or one-sided presence, is a
 *      hard reject — that's the wrong sibling bucket or the wrong question)
 *   3. timing: the sub-market's end date is within 1 day of this market's
 *      resolvesAt
 * Any failing dimension forces null — there is no partial-credit "medium"
 * output from this adapter. "source" (the 4th dimension in the project's
 * spec) is not independently verifiable without the LLM-based resolution
 * structuring (Phase 2, unconfigured this run) — documented as a known gap;
 * both Polymarket and Delphi being algorithmically-sourced/tracked markets
 * on the same real-world event lowers the practical risk, but this is not
 * enforced in code today.
 *
 * Many Polymarket events are range-bucketed (eleven sibling markets like
 * "0-19 posts", "20-39 posts", ...) rather than one threshold market — the
 * numeric-condition check above is what disambiguates the correct sibling.
 */
import type { NormalizedMarket } from "../../markets/types.js";
import type { ConsensusAdapter, ConsensusMatch } from "./types.js";
import { distributionFromSingleOutcome } from "../types.js";
import { wordOverlapScore, dateProximityScore, extractNumericCondition, numericConditionsAgree, buildSearchQuery } from "./textMatch.js";

const SEARCH_URL = "https://gamma-api.polymarket.com/public-search";
const FETCH_TIMEOUT_MS = 8000;
const TEXT_THRESHOLD = 0.5;
const DATE_THRESHOLD_DAYS = 1;

interface PmMarket {
  question: string;
  outcomes?: string; // JSON-encoded string array
  outcomePrices?: string; // JSON-encoded string array
  endDate?: string;
  active?: boolean;
  closed?: boolean;
  slug?: string;
}

interface PmEvent {
  title: string;
  slug: string;
  endDate?: string;
  markets?: PmMarket[];
}

interface PmSearchResponse {
  events?: PmEvent[];
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function parseJsonArray(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

interface Candidate {
  event: PmEvent;
  market: PmMarket;
  textScore: number;
}

/** Hard AND-gate: subject + threshold + timing must ALL correspond. Returns null on any failure. */
function passesHardGate(delphi: NormalizedMarket, event: PmEvent, pmMarket: PmMarket): number | null {
  if (pmMarket.active === false || pmMarket.closed === true) return null;

  const textScore = wordOverlapScore(delphi.resolution.criteria, `${event.title} ${pmMarket.question}`);
  if (textScore < TEXT_THRESHOLD) return null;

  const delphiNumeric = extractNumericCondition(delphi.question);
  const pmNumeric = extractNumericCondition(pmMarket.question);
  const numericAgreement = numericConditionsAgree(delphiNumeric, pmNumeric);
  // false = both present but disagree (wrong bucket). true = both present and agree. null = neither present (ok, nothing to check).
  // One-sided presence (exactly one side has a numeric condition) is also a reject — the questions aren't asking the same thing.
  if (numericAgreement === false) return null;
  if ((delphiNumeric === null) !== (pmNumeric === null)) return null;

  const pmEndDate = pmMarket.endDate ?? event.endDate;
  if (!delphi.resolvesAt || !pmEndDate) return null;
  const dateScore = dateProximityScore(delphi.resolvesAt, new Date(pmEndDate), DATE_THRESHOLD_DAYS);
  if (dateScore < 1) return null; // must be within DATE_THRESHOLD_DAYS, not just "close"

  return textScore;
}

export const polymarketAdapter: ConsensusAdapter = {
  name: "polymarket",

  isConfigured(): boolean {
    return true; // public API, no key required
  },

  async match(market: NormalizedMarket): Promise<ConsensusMatch | null> {
    const query = encodeURIComponent(buildSearchQuery(market.question));
    const data = await fetchJson<PmSearchResponse>(`${SEARCH_URL}?q=${query}&limit_per_type=8`);
    if (!data?.events?.length) return null;

    let best: Candidate | null = null;
    for (const event of data.events) {
      for (const pmMarket of event.markets ?? []) {
        const textScore = passesHardGate(market, event, pmMarket);
        if (textScore !== null && (!best || textScore > best.textScore)) {
          best = { event, market: pmMarket, textScore };
        }
      }
    }

    if (!best) return null;

    const outcomes = parseJsonArray(best.market.outcomes);
    const prices = parseJsonArray(best.market.outcomePrices).map(Number);
    if (outcomes.length === 0 || prices.length !== outcomes.length) return null;

    const targetLabel = (market.outcomes[0] ?? "").trim().toLowerCase();
    const idx = outcomes.findIndex((o) => o.trim().toLowerCase() === targetLabel);
    const probability = prices[idx >= 0 ? idx : 0];
    if (probability === undefined || Number.isNaN(probability)) return null;

    return {
      outcomes: distributionFromSingleOutcome(0, probability, 0.8, market.outcomeCount),
      sourceName: "polymarket",
      matchQuality: "high",
      detail: `matched "${best.market.question}" in event "${best.event.title}" (textScore=${best.textScore.toFixed(2)}, all gates passed)`,
      sourceUrl: `https://polymarket.com/event/${best.event.slug}`,
    };
  },
};
