/**
 * Phase 2 checkpoint driver: for every live open market, run the consensus
 * adapters (priority order, "high" quality wins immediately), structure the
 * resolution (LLM if configured, degraded fallback otherwise), run
 * forecasting when no "high" consensus match exists, and fuse into a
 * per-outcome combined signal + edge. Read-only — no trading, no risk gate,
 * no sizing (see Phase 3 for those).
 *
 * Usage: npm run print-signals
 */
import { fetchOpenMarkets } from "../src/markets/fetch.js";
import { findConsensusMatch, shouldRunForecast } from "../src/signals/consensus/index.js";
import { structureResolution } from "../src/signals/forecasting/structureResolution.js";
import { forecastProbability } from "../src/signals/forecasting/forecast.js";
import { isLLMConfigured } from "../src/signals/forecasting/index.js";
import { combineSignals } from "../src/signals/combine.js";
import { signals as signalsConfig } from "../src/config/index.js";

const markets = await fetchOpenMarkets({ limit: 50 });

console.log("=== Adapter configuration ===");
console.log(`polymarket:      configured (public API, no key)`);
console.log(`the-odds-api:    ${signalsConfig.oddsApiKey ? "configured" : "unconfigured (no ODDS_API_KEY)"}`);
console.log(`binance-vol:     configured (public API, no key)`);
console.log(`LLM (${signalsConfig.llmModel}): ${isLLMConfigured() ? "configured" : "unconfigured (no ANTHROPIC_API_KEY)"}`);
console.log(`search:          ${signalsConfig.searchApiKey ? "configured" : "unconfigured (no SEARCH_API_KEY)"}`);
console.log("");

if (markets.length === 0) {
  console.log("No open markets found. Valid state — nothing to run signals over.");
  process.exit(0);
}

let highConsensusCount = 0;
let forecastUsedCount = 0;
let anySignalCount = 0;
let singleOutcomeFlagCount = 0;

const rows: Array<{
  question: string;
  domain: string;
  price0: number;
  consensusProb0: string;
  consensusSrc: string;
  consensusQuality: string;
  forecastProb0: string;
  combinedProb0: string;
  edge0: string;
  flag: string;
}> = [];

for (const market of markets) {
  const prices = market.spotPrices ?? market.outcomes.map(() => NaN);

  const { match: consensus, attempts } = await findConsensusMatch(market);
  if (consensus?.matchQuality === "high") highConsensusCount++;

  const structured = await structureResolution(market);
  const forecast = shouldRunForecast(consensus) ? await forecastProbability(market, structured) : null;
  if (forecast) forecastUsedCount++;

  const combined = combineSignals(prices, consensus, forecast);
  if (!combined.perOutcome.every((o) => o.probability === null)) anySignalCount++;
  if (combined.singleOutcomeOnly) singleOutcomeFlagCount++;

  console.log(`--- ${market.address} [${market.domain}] ---`);
  console.log(`Question: ${market.question}`);
  console.log(`Outcomes: ${market.outcomes.map((o, i) => `${o}=${prices[i]?.toFixed(4)}`).join(", ")}`);
  console.log(`Structured resolution (LLM=${structured.structuredByLLM}): subject="${structured.subject}"`);
  console.log(`Consensus attempts: ${attempts.map((a) => `${a.adapterName}=${a.configured ? (a.result ? a.result.matchQuality.toUpperCase() : "no-match") : "unconfigured"}`).join(", ")}`);
  if (consensus) {
    console.log(`  -> ${consensus.sourceName} (${consensus.matchQuality}): ${consensus.detail}`);
  }
  if (forecast) {
    console.log(`Forecast: ${forecast.outcomes.map((o, i) => `${market.outcomes[i]}=${o.probability?.toFixed(4)}`).join(", ")} | ${forecast.rationale}`);
  } else if (shouldRunForecast(consensus)) {
    console.log(`Forecast: none (LLM ${isLLMConfigured() ? "configured but call/parse failed" : "unconfigured"})`);
  } else {
    console.log(`Forecast: skipped (high-quality consensus already found)`);
  }
  console.log(`Combined: ${combined.note}${combined.singleOutcomeOnly ? "" : ""}`);
  console.log("");

  rows.push({
    question: market.question.slice(0, 45),
    domain: market.domain,
    price0: prices[0] ?? NaN,
    consensusProb0: consensus?.outcomes[0]?.probability !== null && consensus?.outcomes[0]?.probability !== undefined ? consensus.outcomes[0].probability.toFixed(3) : "-",
    consensusSrc: consensus?.sourceName ?? "-",
    consensusQuality: consensus?.matchQuality ?? "-",
    forecastProb0: forecast?.outcomes[0]?.probability !== null && forecast?.outcomes[0]?.probability !== undefined ? forecast.outcomes[0].probability.toFixed(3) : "-",
    combinedProb0: combined.perOutcome[0]?.probability !== null && combined.perOutcome[0]?.probability !== undefined ? combined.perOutcome[0].probability.toFixed(3) : "-",
    edge0: combined.perOutcome[0]?.edge !== null && combined.perOutcome[0]?.edge !== undefined ? combined.perOutcome[0].edge.toFixed(3) : "-",
    flag: combined.singleOutcomeOnly ? "SINGLE-OUTCOME-ONLY" : "",
  });
}

console.log("=== Per-market signal table (outcome[0]) ===");
console.table(rows);

console.log("=== Coverage ===");
console.log(`Total open markets: ${markets.length}`);
console.log(`HIGH-quality consensus match: ${highConsensusCount}/${markets.length}`);
console.log(`Forecast used: ${forecastUsedCount}/${markets.length}`);
console.log(`Any combined signal at all (any outcome): ${anySignalCount}/${markets.length}`);
console.log(`Flagged single-outcome-only: ${singleOutcomeFlagCount}/${markets.length}`);
console.log(`No signal (neither consensus nor forecast on any outcome): ${markets.length - anySignalCount}/${markets.length}`);
