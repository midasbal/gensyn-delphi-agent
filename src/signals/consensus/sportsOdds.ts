/**
 * Sports odds consensus adapter (The Odds API — the-odds-api.com).
 *
 * NOT independently verified live: this project has no ODDS_API_KEY
 * provisioned, so this adapter has never actually been called against the
 * real API this session. Implemented from the documented API shape
 * (api.the-odds-api.com/v4/sports/{sport}/odds, h2h market, bookmaker
 * consensus odds) — treat the request/response handling as unverified until
 * it runs once with a real key.
 *
 * Free tier (as documented by the provider): 500 requests/month, one
 * request per sport-key per call regardless of event count. That budget is
 * why this adapter queries a small, fixed list of sport keys rather than
 * the full sport catalog, and only when the market's domain looks
 * sports-like.
 *
 * MATCH IS A HARD AND-GATE (see polymarket.ts for the same reasoning): a
 * match is only returned — as "high" quality — if BOTH the team-name overlap
 * against the event's home/away teams clears a high bar AND the event's
 * commence_time is within 1 day of this market's resolvesAt. Any failing
 * dimension forces null. Only handles moneyline/h2h framing — Delphi sports
 * markets phrased as prop bets, bucketed stat ranges, or outright-winner
 * futures are correctly NOT matched by this adapter (h2h looks for a specific
 * two-team matchup, not a multi-entrant futures market) — see polymarket.ts,
 * which is what actually matched the one live golf-futures market this
 * session (The Odds API's futures markets are a separate, paid-tier product
 * not used here).
 */
import type { NormalizedMarket } from "../../markets/types.js";
import type { ConsensusAdapter, ConsensusMatch } from "./types.js";
import { distributionFromSingleOutcome } from "../types.js";
import { signals } from "../../config/index.js";
import { wordOverlapScore, dateProximityScore, extractNumericCondition } from "./textMatch.js";
import { fetchJsonWithTimeout } from "../../util/fetchJson.js";

const BASE_URL = "https://api.the-odds-api.com/v4/sports";
const FETCH_TIMEOUT_MS = 8000;
const TEXT_THRESHOLD = 0.5;
const DATE_THRESHOLD_DAYS = 1;

// Small, fixed set to respect the free-tier request budget — one call per
// key per market evaluated. Extend deliberately, not automatically: each
// addition here should be a league confirmed live against
// /v4/sports (bug fix, live testing on the real market set: CFL is
// covered — key confirmed via /v4/sports — but was missing here, so a
// real CFL market never even got queried, regardless of team-name
// matching).
const SPORT_KEYS = [
  "soccer_epl",
  "soccer_usa_mls",
  "americanfootball_nfl",
  "americanfootball_cfl",
  "basketball_nba",
  "baseball_mlb",
  "icehockey_nhl",
];

interface OddsOutcome {
  name: string;
  price: number; // decimal odds
}
interface OddsMarketBlock {
  key: string;
  outcomes: OddsOutcome[];
}
interface Bookmaker {
  key: string;
  markets: OddsMarketBlock[];
}
interface OddsEvent {
  id: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: Bookmaker[];
}

/** No-vig implied probability for the named side, averaged across bookmakers. */
function impliedProbability(event: OddsEvent, sideName: string): number | null {
  const probs: number[] = [];
  for (const bk of event.bookmakers) {
    const h2h = bk.markets.find((m) => m.key === "h2h");
    if (!h2h) continue;
    const side = h2h.outcomes.find((o) => o.name === sideName);
    const other = h2h.outcomes.find((o) => o.name !== sideName);
    if (!side || !other) continue;
    const pSide = 1 / side.price;
    const pOther = 1 / other.price;
    const total = pSide + pOther; // remove vig by renormalizing to sum 1
    if (total > 0) probs.push(pSide / total);
  }
  if (probs.length === 0) return null;
  return probs.reduce((a, b) => a + b, 0) / probs.length;
}

export const sportsOddsAdapter: ConsensusAdapter = {
  name: "the-odds-api",

  isConfigured(): boolean {
    return !!signals.oddsApiKey;
  },

  async match(market: NormalizedMarket): Promise<ConsensusMatch | null> {
    if (!signals.oddsApiKey) return null;
    if (!/sport/i.test(market.domain)) return null;

    // h2h/moneyline framing only (see file header). A numeric threshold in
    // the question — over/under totals ("combine for 56+ points"), prop-bet
    // stat ranges, etc. — means this isn't a simple two-way "who wins"
    // market, and h2h odds can't answer it: team names would still overlap
    // and the date would still match, so without this guard a covered
    // league's totals/prop market would get silently, wrongly matched with
    // a "which team wins" probability standing in for a completely
    // different question. Bucketed-range markets are polymarket.ts's job.
    if (extractNumericCondition(market.question)) return null;

    for (const sportKey of SPORT_KEYS) {
      const url = `${BASE_URL}/${sportKey}/odds?apiKey=${signals.oddsApiKey}&regions=us&markets=h2h`;
      const events = await fetchJsonWithTimeout<OddsEvent[]>(url, FETCH_TIMEOUT_MS);
      if (!events?.length) continue;

      for (const event of events) {
        const eventText = `${event.home_team} ${event.away_team}`;
        const textScore = wordOverlapScore(market.question, eventText);
        if (textScore < TEXT_THRESHOLD) continue;

        if (!market.resolvesAt) continue;
        const dateScore = dateProximityScore(market.resolvesAt, new Date(event.commence_time), DATE_THRESHOLD_DAYS);
        if (dateScore < 1) continue;

        // Convention: outcomes[0] is treated as "the named side wins" — only
        // sound when the Delphi question names one of the two teams as the
        // subject. Best-effort: pick whichever team name appears in the question.
        const homeInQuestion = wordOverlapScore(market.question, event.home_team) > 0;
        const sideName = homeInQuestion ? event.home_team : event.away_team;
        const probability = impliedProbability(event, sideName);
        if (probability === null) continue;

        return {
          outcomes: distributionFromSingleOutcome(0, probability, 0.75, market.outcomeCount),
          sourceName: "the-odds-api",
          matchQuality: "high",
          detail: `matched event "${eventText}" (${sportKey}, textScore=${textScore.toFixed(2)}, all gates passed), no-vig h2h consensus`,
        };
      }
    }

    return null;
  },
};
