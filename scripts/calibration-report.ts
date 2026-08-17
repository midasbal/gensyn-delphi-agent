/**
 * OFFLINE, READ ONLY trade-scored post-mortem. Does not import or touch
 * the live agent, the loop, persistence, or execution modules. Reads a
 * state file (point it at a COPY, never the live state/agent-state.json)
 * and a resolutions file you provide, and writes a report. No network
 * calls, no writes to state.
 *
 * WHY TRADE-SCORED, NOT CACHE-SCORED: the prior version of this script
 * scored state/agent-state.json's forecastCache directly. forecastCache
 * holds ONE entry per market, the LATEST cached forecast, which is not
 * necessarily the forecast that was live when a trade actually happened.
 * A market can be re-forecast after the trade (staleness expiry, a
 * changed input), silently swapping in a forecast the trade never saw.
 * Scoring the cache measures "how good is the model's forecast right
 * now", not "how good were the forecasts that actually drove capital".
 * This version scores portfolio.trades instead: the record of what the
 * agent actually bought, at what price, believing what probability, at
 * the moment it bought it.
 *
 * INPUT 1: state file's portfolio.trades. Each entry (see
 * src/portfolio/types.ts's TradeRecord):
 *   { timestamp, marketAddress, outcomeIdx, question, shares, tokensIn,
 *     effectivePrice, slippagePct, quotedPrice, ourProbability, edge }
 * quotedPrice is the market's implied probability for outcomeIdx AT TRADE
 * TIME. ourProbability is the model's probability for outcomeIdx AT TRADE
 * TIME. edge is already ourProbability - quotedPrice as computed live,
 * used directly rather than recomputed.
 *
 * The trade record does not carry the outcome's LABEL (e.g. "Yes"), only
 * its index. To determine win/loss the label is looked up from
 * forecastCache[marketAddress]'s inputHash.outcomes[outcomeIdx] (same
 * cache as before, just used here only to resolve a label, not to score
 * anything). If that market has no forecastCache entry at all, or
 * outcomeIdx is out of range for its outcomes array, the label cannot be
 * recovered and the trade is excluded, listed under unscoredTrades with
 * the reason, never guessed.
 *
 * INPUT 2: a resolutions file (JSON array), each entry:
 *   {
 *     "marketAddress"?: string,           // match by address, preferred
 *     "question"?: string,                // match by exact question text if no address
 *     "resolvedOutcome": string | number, // the winning outcome's label (matched
 *                                         // case-insensitively against the label
 *                                         // resolved above) OR a 0-based outcome index
 *     "volume"?: number
 *   }
 * At least one of marketAddress or question must be present. Matching a
 * trade to a resolution is EXACT (address exact match, or question exact
 * match after trim/whitespace-collapse) never fuzzy. A resolutions.json
 * entry may also carry a legacy marketPriceAtResolution field (from the
 * prior cache-scored version of this script); it is accepted but ignored
 * here, since market price at trade time already lives on the trade
 * itself as quotedPrice.
 *
 * PER RESOLVED, MATCHED TRADE:
 *   won = 1 if the bought outcome's label equals resolvedOutcome, else 0.
 *   realizedPnl = won ? (shares - tokensIn) : (-tokensIn).
 *     (shares is a share COUNT, not a token amount, but a winning LMSR
 *     share on this competition pays exactly 1 TST, so shares (count)
 *     equals the TST payout for a won bet, and won ? shares : 0 is that
 *     payout. This is the same convention portfolio/valuation.ts's
 *     settled-payout path uses.)
 *   modelSquaredError = (ourProbability - won)^2
 *   marketSquaredError = (quotedPrice - won)^2
 *
 * EVIDENCE RECOVERABILITY: a trade's forecast "had evidence" is only
 * knowable if the CURRENT forecastCache entry for that market is STILL
 * the same forecast that drove the trade, i.e. the market was never
 * re-forecast since. This is checked by comparing the trade's
 * ourProbability against the cache's outcomes[outcomeIdx].probability
 * (within EVIDENCE_MATCH_EPSILON): a match means the cache almost
 * certainly still reflects the trade-time forecast (same evidence flag
 * applies); a mismatch means the cache has moved on and evidence data for
 * the trade-driving forecast is lost. Trades where this cannot be
 * determined are marked hasEvidence: null and excluded from the
 * evidence-based bias split specifically (they remain in every other
 * metric), never guessed either way.
 *
 * SECONDARY SECTION: the prior cache-based reliability curve is kept,
 * clearly separated, because it answers a different, still useful
 * question: "across every forecast the model has ever cached, regardless
 * of whether it drove a trade, how calibrated is it overall". It pairs
 * EVERY outcome of every forecastCache entry (both winning and losing
 * outcomes, needed for a bucket to mean anything) with whether that
 * outcome resolved true, using the SAME resolutions.json.
 *
 * Usage:
 *   npx tsx scripts/calibration-report.ts \
 *     --state <path-to-a-COPY-of-agent-state.json> \
 *     --resolutions <path-to-resolutions.json> \
 *     [--out-json reports/calibration-report.json] \
 *     [--out-csv reports/calibration-report.csv]
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { classifyDomain } from "../src/markets/classify.js";

const LARGE_EDGE_THRESHOLD = 0.25;
const RELIABILITY_BUCKET_WIDTH = 0.1;
const EVIDENCE_MATCH_EPSILON = 1e-6;

// ---------- input shapes ----------

interface OutcomeEstimate {
  probability: number | null;
  confidence: number;
}

interface ForecastResultShape {
  outcomes: OutcomeEstimate[];
  rationale?: string;
  sourcesUsed?: string[];
  baseRate?: number;
  evidenceQuality?: "strong" | "moderate" | "thin" | "none";
}

interface CacheEntryShape {
  inputHash: string;
  result: ForecastResultShape;
  cachedAtMs: number;
}

interface ParsedInputHash {
  question: string;
  outcomes: string[];
  resolvesAt: string | null;
}

interface TradeRecordShape {
  timestamp: string;
  marketAddress: string;
  outcomeIdx: number;
  question: string;
  shares: number;
  tokensIn: number;
  effectivePrice: number;
  slippagePct: number;
  quotedPrice: number;
  ourProbability: number;
  edge: number;
}

interface StateFileShape {
  forecastCache?: Record<string, CacheEntryShape>;
  portfolio?: { trades?: TradeRecordShape[] };
}

interface ResolutionEntry {
  marketAddress?: string;
  question?: string;
  resolvedOutcome: string | number;
  marketPriceAtResolution?: number; // legacy, accepted, unused here
  volume?: number;
}

// ---------- parsed cache lookup ----------

interface ParsedCacheEntry {
  question: string;
  outcomes: string[];
  hasEvidence: boolean;
  evidenceQuality: string;
  outcomeProbabilities: Array<number | null>;
}

function parseForecastCacheByAddress(state: StateFileShape): { byAddress: Map<string, ParsedCacheEntry>; parseErrors: string[] } {
  const byAddress = new Map<string, ParsedCacheEntry>();
  const parseErrors: string[] = [];

  for (const [marketAddress, entry] of Object.entries(state.forecastCache ?? {})) {
    let parsedHash: ParsedInputHash;
    try {
      parsedHash = JSON.parse(entry.inputHash) as ParsedInputHash;
    } catch {
      parseErrors.push(`${marketAddress}: inputHash is not valid JSON, skipped`);
      continue;
    }
    if (!Array.isArray(parsedHash.outcomes) || typeof parsedHash.question !== "string") {
      parseErrors.push(`${marketAddress}: inputHash missing question/outcomes, skipped`);
      continue;
    }
    if (!entry.result || !Array.isArray(entry.result.outcomes)) {
      parseErrors.push(`${marketAddress}: cache entry has no valid result.outcomes, skipped`);
      continue;
    }

    const sourcesUsedCount = entry.result.sourcesUsed?.length ?? 0;
    const evidenceQuality = entry.result.evidenceQuality ?? "unspecified";
    byAddress.set(marketAddress, {
      question: parsedHash.question,
      outcomes: parsedHash.outcomes,
      hasEvidence: sourcesUsedCount > 0 && evidenceQuality !== "none",
      evidenceQuality,
      outcomeProbabilities: entry.result.outcomes.map((o) => o.probability),
    });
  }

  return { byAddress, parseErrors };
}

// ---------- resolution matching (shared by trades and the secondary cache curve) ----------

function normalizeQuestion(q: string): string {
  return q.trim().replace(/\s+/g, " ");
}

function buildResolutionIndex(resolutions: ResolutionEntry[]): {
  byAddress: Map<string, ResolutionEntry>;
  byQuestion: Map<string, ResolutionEntry>;
} {
  const byAddress = new Map<string, ResolutionEntry>();
  const byQuestion = new Map<string, ResolutionEntry>();
  for (const r of resolutions) {
    if (r.marketAddress) byAddress.set(r.marketAddress.toLowerCase(), r);
    if (r.question) byQuestion.set(normalizeQuestion(r.question).toLowerCase(), r);
  }
  return { byAddress, byQuestion };
}

function findResolution(
  marketAddress: string,
  question: string,
  index: { byAddress: Map<string, ResolutionEntry>; byQuestion: Map<string, ResolutionEntry> }
): ResolutionEntry | null {
  return index.byAddress.get(marketAddress.toLowerCase()) ?? index.byQuestion.get(normalizeQuestion(question).toLowerCase()) ?? null;
}

/** true/false if determinable, null if resolvedOutcome is malformed (a non-integer number). Never guesses. */
function outcomeWon(outcomeIdx: number, outcomeLabel: string, resolution: ResolutionEntry): boolean | null {
  if (typeof resolution.resolvedOutcome === "number") {
    return Number.isInteger(resolution.resolvedOutcome) ? resolution.resolvedOutcome === outcomeIdx : null;
  }
  return resolution.resolvedOutcome.trim().toLowerCase() === outcomeLabel.trim().toLowerCase();
}

function resolveOutcomeIndexInList(resolvedOutcome: string | number, outcomes: string[]): number | null {
  if (typeof resolvedOutcome === "number") {
    return Number.isInteger(resolvedOutcome) && resolvedOutcome >= 0 && resolvedOutcome < outcomes.length ? resolvedOutcome : null;
  }
  const target = resolvedOutcome.trim().toLowerCase();
  const idx = outcomes.findIndex((o) => o.trim().toLowerCase() === target);
  return idx === -1 ? null : idx;
}

// ---------- arg parsing ----------

function parseArgs(argv: string[]): { statePath: string; resolutionsPath: string; outJson: string; outCsv: string } {
  const get = (flag: string, fallback: string): string => {
    const idx = argv.indexOf(flag);
    return idx !== -1 && argv[idx + 1] ? argv[idx + 1]! : fallback;
  };
  return {
    statePath: get("--state", "state/agent-state.json"),
    resolutionsPath: get("--resolutions", ""),
    outJson: get("--out-json", "reports/calibration-report.json"),
    outCsv: get("--out-csv", "reports/calibration-report.csv"),
  };
}

async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as T;
}

// ---------- primary: trade scoring ----------

interface ScoredTrade {
  timestamp: string;
  marketAddress: string;
  question: string;
  outcomeIdx: number;
  outcomeLabel: string;
  ourProbability: number;
  quotedPrice: number;
  edge: number;
  tokensIn: number;
  shares: number;
  won: 0 | 1;
  realizedPnl: number;
  modelSquaredError: number;
  marketSquaredError: number;
  domain: string;
  hasEvidence: boolean | null;
}

interface UnscoredTrade {
  timestamp: string;
  marketAddress: string;
  question: string;
  outcomeIdx: number;
  reason: string;
}

function scoreTrades(
  trades: TradeRecordShape[],
  cacheByAddress: Map<string, ParsedCacheEntry>,
  resolutionIndex: ReturnType<typeof buildResolutionIndex>
): { scored: ScoredTrade[]; unscored: UnscoredTrade[] } {
  const scored: ScoredTrade[] = [];
  const unscored: UnscoredTrade[] = [];

  for (const trade of trades) {
    const cacheEntry = cacheByAddress.get(trade.marketAddress);
    if (!cacheEntry) {
      unscored.push({
        timestamp: trade.timestamp,
        marketAddress: trade.marketAddress,
        question: trade.question,
        outcomeIdx: trade.outcomeIdx,
        reason: "no forecastCache entry for this market, cannot resolve the bought outcome's label",
      });
      continue;
    }
    const outcomeLabel = cacheEntry.outcomes[trade.outcomeIdx];
    if (outcomeLabel === undefined) {
      unscored.push({
        timestamp: trade.timestamp,
        marketAddress: trade.marketAddress,
        question: trade.question,
        outcomeIdx: trade.outcomeIdx,
        reason: `outcomeIdx ${trade.outcomeIdx} is out of range for this market's cached outcomes [${cacheEntry.outcomes.join(", ")}]`,
      });
      continue;
    }

    const resolution = findResolution(trade.marketAddress, trade.question, resolutionIndex);
    if (!resolution) {
      unscored.push({
        timestamp: trade.timestamp,
        marketAddress: trade.marketAddress,
        question: trade.question,
        outcomeIdx: trade.outcomeIdx,
        reason: "no matching entry in resolutions file",
      });
      continue;
    }

    const won = outcomeWon(trade.outcomeIdx, outcomeLabel, resolution);
    if (won === null) {
      unscored.push({
        timestamp: trade.timestamp,
        marketAddress: trade.marketAddress,
        question: trade.question,
        outcomeIdx: trade.outcomeIdx,
        reason: `resolvedOutcome "${String(resolution.resolvedOutcome)}" is malformed (not a valid label or integer index)`,
      });
      continue;
    }

    const wonNum: 0 | 1 = won ? 1 : 0;
    const realizedPnl = won ? trade.shares - trade.tokensIn : -trade.tokensIn;

    // Evidence recoverability: only trust the cache's hasEvidence flag for
    // this trade if the cache still holds the SAME forecast, detected by
    // comparing probabilities. See script header for why this can't be
    // assumed.
    const cachedProbForThisOutcome = cacheEntry.outcomeProbabilities[trade.outcomeIdx];
    const forecastUnchanged = cachedProbForThisOutcome !== null && cachedProbForThisOutcome !== undefined && Math.abs(cachedProbForThisOutcome - trade.ourProbability) <= EVIDENCE_MATCH_EPSILON;
    const hasEvidence = forecastUnchanged ? cacheEntry.hasEvidence : null;

    scored.push({
      timestamp: trade.timestamp,
      marketAddress: trade.marketAddress,
      question: trade.question,
      outcomeIdx: trade.outcomeIdx,
      outcomeLabel,
      ourProbability: trade.ourProbability,
      quotedPrice: trade.quotedPrice,
      edge: trade.edge,
      tokensIn: trade.tokensIn,
      shares: trade.shares,
      won: wonNum,
      realizedPnl,
      modelSquaredError: (trade.ourProbability - wonNum) ** 2,
      marketSquaredError: (trade.quotedPrice - wonNum) ** 2,
      domain: classifyDomain("", trade.question),
      hasEvidence,
    });
  }

  return { scored, unscored };
}

// ---------- aggregate metrics over scored trades ----------

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

function weightedMean(values: Array<{ value: number; weight: number }>): number | null {
  const totalWeight = values.reduce((sum, v) => sum + v.weight, 0);
  if (totalWeight <= 0) return null;
  return values.reduce((sum, v) => sum + v.value * v.weight, 0) / totalWeight;
}

interface BrierSummary {
  n: number;
  modelBrierCountWeighted: number | null;
  marketBrierCountWeighted: number | null;
  modelBrierCapitalWeighted: number | null;
  marketBrierCapitalWeighted: number | null;
  capitalWeightedGap: number | null; // marketBrier - modelBrier, capital weighted. Positive = model beat market.
}

function summarizeBrier(trades: ScoredTrade[]): BrierSummary {
  if (trades.length === 0) {
    return { n: 0, modelBrierCountWeighted: null, marketBrierCountWeighted: null, modelBrierCapitalWeighted: null, marketBrierCapitalWeighted: null, capitalWeightedGap: null };
  }
  const modelBrierCountWeighted = mean(trades.map((t) => t.modelSquaredError));
  const marketBrierCountWeighted = mean(trades.map((t) => t.marketSquaredError));
  const modelBrierCapitalWeighted = weightedMean(trades.map((t) => ({ value: t.modelSquaredError, weight: t.tokensIn })));
  const marketBrierCapitalWeighted = weightedMean(trades.map((t) => ({ value: t.marketSquaredError, weight: t.tokensIn })));
  const capitalWeightedGap = modelBrierCapitalWeighted !== null && marketBrierCapitalWeighted !== null ? marketBrierCapitalWeighted - modelBrierCapitalWeighted : null;
  return { n: trades.length, modelBrierCountWeighted, marketBrierCountWeighted, modelBrierCapitalWeighted, marketBrierCapitalWeighted, capitalWeightedGap };
}

interface PnlSummary {
  totalRealizedPnl: number;
  winCount: number;
  winPnlSum: number;
  lossCount: number;
  lossPnlSum: number;
}

function summarizePnl(trades: ScoredTrade[]): PnlSummary {
  const won = trades.filter((t) => t.won === 1);
  const lost = trades.filter((t) => t.won === 0);
  return {
    totalRealizedPnl: trades.reduce((sum, t) => sum + t.realizedPnl, 0),
    winCount: won.length,
    winPnlSum: won.reduce((sum, t) => sum + t.realizedPnl, 0),
    lossCount: lost.length,
    lossPnlSum: lost.reduce((sum, t) => sum + t.realizedPnl, 0),
  };
}

interface LargeEdgeSummary {
  threshold: number;
  count: number;
  winRate: number | null;
  totalRealizedPnl: number;
  brier: BrierSummary;
  trades: Array<{ marketAddress: string; question: string; edge: number; won: 0 | 1; realizedPnl: number }>;
}

function largeEdgeBreakdown(trades: ScoredTrade[]): LargeEdgeSummary {
  const large = trades.filter((t) => Math.abs(t.edge) > LARGE_EDGE_THRESHOLD);
  return {
    threshold: LARGE_EDGE_THRESHOLD,
    count: large.length,
    winRate: large.length === 0 ? null : mean(large.map((t) => t.won)),
    totalRealizedPnl: large.reduce((sum, t) => sum + t.realizedPnl, 0),
    brier: summarizeBrier(large),
    trades: large.map((t) => ({ marketAddress: t.marketAddress, question: t.question, edge: t.edge, won: t.won, realizedPnl: t.realizedPnl })),
  };
}

// ---------- secondary: cache-based reliability curve ----------

interface ReliabilityBucket {
  bucketLabel: string;
  n: number;
  meanPredicted: number | null;
  actualFrequency: number | null;
}

function buildCacheReliabilityCurve(
  cacheByAddress: Map<string, ParsedCacheEntry>,
  resolutionIndex: ReturnType<typeof buildResolutionIndex>
): { curve: ReliabilityBucket[]; resolvedCacheEntries: number; unresolvedCacheEntries: number } {
  const rows: Array<{ prob: number; actual: 0 | 1 }> = [];
  let resolvedCacheEntries = 0;
  let unresolvedCacheEntries = 0;

  for (const [marketAddress, entry] of cacheByAddress) {
    const resolution = findResolution(marketAddress, entry.question, resolutionIndex);
    if (!resolution) {
      unresolvedCacheEntries++;
      continue;
    }
    const resolvedIdx = resolveOutcomeIndexInList(resolution.resolvedOutcome, entry.outcomes);
    if (resolvedIdx === null) {
      unresolvedCacheEntries++;
      continue;
    }
    resolvedCacheEntries++;
    entry.outcomeProbabilities.forEach((p, i) => {
      if (p !== null) rows.push({ prob: p, actual: i === resolvedIdx ? 1 : 0 });
    });
  }

  const bucketCount = Math.round(1 / RELIABILITY_BUCKET_WIDTH);
  const curve: ReliabilityBucket[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const low = i / bucketCount;
    const high = (i + 1) / bucketCount;
    const inBucket = rows.filter((r) => (i === 0 ? r.prob >= low : r.prob > low) && r.prob <= high);
    curve.push({
      bucketLabel: `${(low * 100).toFixed(0)}-${(high * 100).toFixed(0)}%`,
      n: inBucket.length,
      meanPredicted: mean(inBucket.map((r) => r.prob)),
      actualFrequency: mean(inBucket.map((r) => r.actual)),
    });
  }
  return { curve, resolvedCacheEntries, unresolvedCacheEntries };
}

// ---------- report assembly ----------

function fmt(n: number | null, digits = 4): string {
  return n === null ? "n/a" : n.toFixed(digits);
}

function buildSummaryParagraph(
  brier: BrierSummary,
  pnl: PnlSummary,
  evidenceGroups: { withEvidence: BrierSummary; noEvidence: BrierSummary; notRecoverableCount: number },
  largeEdge: LargeEdgeSummary,
  unscoredCount: number,
  scoredCount: number
): string {
  const parts: string[] = [];
  parts.push(`Scored ${scoredCount} resolved, matched trades (${unscoredCount} trades excluded, no matching resolution or unrecoverable outcome label).`);
  if (brier.capitalWeightedGap !== null) {
    const beat = brier.capitalWeightedGap > 0;
    parts.push(
      `Capital weighted, the model's forecasts ${beat ? "beat" : "did not beat"} the prices they traded against: model Brier ${fmt(brier.modelBrierCapitalWeighted)} versus market Brier ${fmt(brier.marketBrierCapitalWeighted)}.`
    );
  }
  parts.push(`Total realized P&L across scored trades was ${fmt(pnl.totalRealizedPnl, 2)} TST (${pnl.winCount} wins summing ${fmt(pnl.winPnlSum, 2)}, ${pnl.lossCount} losses summing ${fmt(pnl.lossPnlSum, 2)}).`);
  if (largeEdge.count > 0) {
    parts.push(
      `Of ${largeEdge.count} trades where the model claimed an edge larger than ${largeEdge.threshold}, the win rate was ${fmt(largeEdge.winRate, 2)} and total realized P&L was ${fmt(largeEdge.totalRealizedPnl, 2)} TST, ${largeEdge.winRate !== null && largeEdge.winRate < 0.5 ? "consistent with the hypothesis that a large claimed edge was anti-signal" : "not showing the large-edge-was-anti-signal pattern in this sample"}.`
    );
  } else {
    parts.push(`No trades in this sample had |edge| larger than ${largeEdge.threshold}.`);
  }
  if (evidenceGroups.withEvidence.n > 0 || evidenceGroups.noEvidence.n > 0) {
    parts.push(
      `Of the trades where evidence status could be recovered, evidence backed trades (n=${evidenceGroups.withEvidence.n}) had model Brier ${fmt(evidenceGroups.withEvidence.modelBrierCountWeighted)} versus ${fmt(evidenceGroups.noEvidence.modelBrierCountWeighted)} for no evidence trades (n=${evidenceGroups.noEvidence.n}); evidence status could not be recovered for ${evidenceGroups.notRecoverableCount} trade(s), excluded from this split.`
    );
  } else {
    parts.push(`Evidence status could not be recovered for any scored trade (the cache no longer matches the trade time forecast for all of them).`);
  }
  return parts.join(" ");
}

async function main(): Promise<void> {
  const { statePath, resolutionsPath, outJson, outCsv } = parseArgs(process.argv.slice(2));

  if (!resolutionsPath) {
    console.error("Missing required --resolutions <path>. Nothing to score without it.");
    process.exitCode = 1;
    return;
  }

  const state = await readJson<StateFileShape>(statePath);
  const resolutions = await readJson<ResolutionEntry[]>(resolutionsPath);
  const resolutionIndex = buildResolutionIndex(resolutions);

  const { byAddress: cacheByAddress, parseErrors } = parseForecastCacheByAddress(state);
  const trades = state.portfolio?.trades ?? [];

  const { scored, unscored } = scoreTrades(trades, cacheByAddress, resolutionIndex);

  const brier = summarizeBrier(scored);
  const pnl = summarizePnl(scored);
  const largeEdge = largeEdgeBreakdown(scored);

  const withEvidence = summarizeBrier(scored.filter((t) => t.hasEvidence === true));
  const noEvidence = summarizeBrier(scored.filter((t) => t.hasEvidence === false));
  const notRecoverableCount = scored.filter((t) => t.hasEvidence === null).length;

  const byDomain = new Map<string, ScoredTrade[]>();
  for (const t of scored) {
    const list = byDomain.get(t.domain) ?? [];
    list.push(t);
    byDomain.set(t.domain, list);
  }
  const domainBreakdown: Record<string, { n: number; brier: BrierSummary; pnl: PnlSummary }> = {};
  for (const [domain, list] of byDomain) domainBreakdown[domain] = { n: list.length, brier: summarizeBrier(list), pnl: summarizePnl(list) };

  const { curve: reliabilityCurve, resolvedCacheEntries, unresolvedCacheEntries } = buildCacheReliabilityCurve(cacheByAddress, resolutionIndex);

  const summaryParagraph = buildSummaryParagraph(brier, pnl, { withEvidence, noEvidence, notRecoverableCount }, largeEdge, unscored.length, scored.length);

  const report = {
    inputs: { statePath, resolutionsPath },
    counts: {
      totalTrades: trades.length,
      scoredTrades: scored.length,
      unscoredTrades: unscored.length,
      totalCachedForecasts: cacheByAddress.size,
      parseErrors: parseErrors.length,
    },
    primaryTradeScored: {
      perTrade: scored,
      unscoredTrades: unscored,
      brier,
      pnl,
      largeEdge,
      biasBreakdown: {
        byEvidence: { withEvidence, noEvidence, notRecoverableCount },
        byDomain: domainBreakdown,
      },
    },
    secondaryCacheReliability: {
      note: "Overall model calibration across every cached forecast, regardless of whether it drove a trade. NOT trade-scored, see script header.",
      resolvedCacheEntries,
      unresolvedCacheEntries,
      curve: reliabilityCurve,
    },
    parseErrors,
    summary: summaryParagraph,
  };

  await mkdir(dirname(outJson), { recursive: true });
  await writeFile(outJson, JSON.stringify(report, null, 2), "utf8");

  const csvLines = ["timestamp,marketAddress,question,outcomeIdx,outcomeLabel,ourProbability,quotedPrice,edge,tokensIn,won,realizedPnl"];
  for (const t of scored) {
    const escapedQuestion = `"${t.question.replace(/"/g, '""')}"`;
    csvLines.push(
      [t.timestamp, t.marketAddress, escapedQuestion, t.outcomeIdx, t.outcomeLabel, fmt(t.ourProbability), fmt(t.quotedPrice), fmt(t.edge), fmt(t.tokensIn, 4), t.won, fmt(t.realizedPnl, 4)].join(",")
    );
  }
  await mkdir(dirname(outCsv), { recursive: true });
  await writeFile(outCsv, csvLines.join("\n") + "\n", "utf8");

  const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);

  console.log("=== Trade-scored calibration report ===");
  console.log(`State file: ${statePath}`);
  console.log(`Resolutions file: ${resolutionsPath}`);
  console.log("");
  console.log(`Total trades: ${trades.length}`);
  console.log(`Scored (resolved + matched): ${scored.length}`);
  console.log(`Unscored (excluded): ${unscored.length}`);
  if (unscored.length > 0) {
    for (const u of unscored) console.log(`  - ${u.marketAddress} outcomeIdx=${u.outcomeIdx}: ${u.reason}`);
  }
  if (parseErrors.length > 0) {
    console.log("");
    console.log("forecastCache parse errors:");
    for (const e of parseErrors) console.log(`  - ${e}`);
  }

  console.log("");
  console.log("--- 1. Per-trade table ---");
  console.log("timestamp                marketAddress  question                              outIdx label  ourProb  quoted  edge     tokensIn  won  pnl");
  for (const t of scored) {
    console.log(
      `${t.timestamp}  ${t.marketAddress.slice(0, 10)}  ${truncate(t.question, 36).padEnd(36)}  ${String(t.outcomeIdx).padStart(6)} ${t.outcomeLabel.padEnd(5)} ${fmt(t.ourProbability, 3).padStart(7)}  ${fmt(t.quotedPrice, 3).padStart(6)}  ${fmt(t.edge, 3).padStart(7)}  ${fmt(t.tokensIn, 2).padStart(8)}  ${t.won}    ${fmt(t.realizedPnl, 2)}`
    );
  }

  console.log("");
  console.log("--- 2. Headline: model vs market Brier (trade-count weighted and capital weighted) ---");
  console.log(`n=${brier.n}`);
  console.log(`Count weighted:   model=${fmt(brier.modelBrierCountWeighted)}  market=${fmt(brier.marketBrierCountWeighted)}`);
  console.log(`Capital weighted: model=${fmt(brier.modelBrierCapitalWeighted)}  market=${fmt(brier.marketBrierCapitalWeighted)}`);
  console.log(`Capital weighted gap (market - model, positive = model beat market): ${fmt(brier.capitalWeightedGap)}`);

  console.log("");
  console.log("--- 3. Realized P&L ---");
  console.log(`Total: ${fmt(pnl.totalRealizedPnl, 4)} TST`);
  console.log(`Wins:   count=${pnl.winCount}  sum=${fmt(pnl.winPnlSum, 4)} TST`);
  console.log(`Losses: count=${pnl.lossCount}  sum=${fmt(pnl.lossPnlSum, 4)} TST`);

  console.log("");
  console.log(`--- 4. Large edge test (|edge| > ${largeEdge.threshold}) ---`);
  console.log(`Count: ${largeEdge.count}`);
  console.log(`Win rate: ${fmt(largeEdge.winRate, 3)}`);
  console.log(`Total realized P&L: ${fmt(largeEdge.totalRealizedPnl, 4)} TST`);
  console.log(`Model Brier within subset: ${fmt(largeEdge.brier.modelBrierCountWeighted)}`);
  console.log(`Market Brier within subset: ${fmt(largeEdge.brier.marketBrierCountWeighted)}`);
  for (const t of largeEdge.trades) {
    console.log(`  - ${t.marketAddress} edge=${t.edge.toFixed(4)} won=${t.won} pnl=${t.realizedPnl.toFixed(4)} (${truncate(t.question, 60)})`);
  }

  console.log("");
  console.log("--- 5. Bias: evidence recoverable vs not ---");
  console.log(`With evidence:    n=${withEvidence.n}  modelBrier=${fmt(withEvidence.modelBrierCountWeighted)}  marketBrier=${fmt(withEvidence.marketBrierCountWeighted)}`);
  console.log(`No evidence:      n=${noEvidence.n}  modelBrier=${fmt(noEvidence.modelBrierCountWeighted)}  marketBrier=${fmt(noEvidence.marketBrierCountWeighted)}`);
  console.log(`Not recoverable:  n=${notRecoverableCount} (cache no longer matches the trade time forecast, excluded from this split only)`);

  console.log("");
  console.log("--- 5. Bias: by domain (best-effort, keyword-classified from question text) ---");
  for (const [domain, d] of Object.entries(domainBreakdown)) {
    console.log(`${domain.padEnd(14)} n=${d.n}  modelBrier=${fmt(d.brier.modelBrierCountWeighted)}  marketBrier=${fmt(d.brier.marketBrierCountWeighted)}  pnl=${fmt(d.pnl.totalRealizedPnl, 2)}`);
  }

  console.log("");
  console.log("--- Secondary: cache based reliability curve (overall model calibration, NOT trade-scored) ---");
  console.log(`Cached forecasts resolved: ${resolvedCacheEntries}  unresolved: ${unresolvedCacheEntries}`);
  console.log("bucket        n    mean_predicted   actual_frequency");
  for (const b of reliabilityCurve) {
    console.log(`${b.bucketLabel.padEnd(12)}  ${String(b.n).padStart(3)}   ${fmt(b.meanPredicted, 3).padStart(14)}   ${fmt(b.actualFrequency, 3).padStart(16)}`);
  }

  console.log("");
  console.log("--- 6. Summary ---");
  console.log(summaryParagraph);
  console.log("");
  console.log(`Wrote ${outJson}`);
  console.log(`Wrote ${outCsv}`);
}

main().catch((err) => {
  console.error("calibration-report failed:", err);
  process.exitCode = 1;
});
