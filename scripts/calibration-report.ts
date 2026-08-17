/**
 * OFFLINE, READ ONLY forecasting-calibration post-mortem. Does not import
 * or touch the live agent, the loop, persistence, or execution modules.
 * Reads a state file (point it at a COPY, never the live
 * state/agent-state.json) and a resolutions file you provide, and writes a
 * calibration report. No network calls, no writes to state.
 *
 * INPUT 1: state file's forecastCache. Each entry is
 *   { inputHash: string, result: ForecastResult, cachedAtMs: number }
 * where inputHash is a JSON string of
 *   { question, outcomes, resolvesAt, subject, condition, comparatorOrThreshold, sourceOfTruth }
 * (see src/signals/forecasting/forecast.ts's hashInputs) and result is
 *   { outcomes: [{ probability: number | null, confidence: number }, ...],
 *     rationale, sourcesUsed: string[], baseRate?, evidenceQuality? }
 * (see src/signals/forecasting/types.ts's ForecastResult). outcomes[i]
 * lines up with the parsed inputHash's outcomes[i], same order.
 *
 * The state file's forecastCache does NOT include the market's category or
 * domain, only the question text. Category/domain splits in this report use
 * markets/classify.ts's classifyDomain(category, question) with an empty
 * category, i.e. keyword classification from the question text alone. This
 * is a best-effort label, not the market's true on-chain category. Said
 * again in the report output so it is never mistaken for ground truth.
 *
 * INPUT 2: a resolutions file (JSON array), each entry:
 *   {
 *     "marketAddress"?: string,          // match by address, preferred
 *     "question"?: string,               // match by exact question text if no address
 *     "resolvedOutcome": string | number,// outcome label (matched case-insensitively
 *                                        // against the market's outcomes array) OR a
 *                                        // 0-based outcome index
 *     "marketPriceAtResolution"?: number,// the market's final implied probability for
 *                                        // resolvedOutcome, 0 to 1. Optional: a market
 *                                        // missing this is still scored on the model
 *                                        // alone, just excluded from model-vs-market
 *                                        // comparison metrics.
 *     "volume"?: number
 *   }
 * At least one of marketAddress or question must be present. Matching is
 * EXACT (address exact match, or question exact match after trimming and
 * whitespace collapse) never fuzzy: this script does not guess, an
 * unmatched forecastCache entry is listed as unresolved and excluded from
 * every scored metric, and an unmatched resolutions.json entry is reported
 * separately as "resolution with no matching cached forecast" rather than
 * silently dropped.
 *
 * METHODOLOGY (read before trusting the numbers):
 *
 * Per-market row (section 1) reports model_prob and market_prob for THE
 * OUTCOME THAT ACTUALLY HAPPENED ONLY, per the brief. Because of that,
 * "actual" in that table is always 1 by construction (it is, by
 * definition, the outcome that happened) and model_error = model_prob - 1,
 * market_error = market_prob - 1, both always <= 0. A value near 0 means
 * the model/market was confident in what actually happened; a large
 * negative value means it was confidently wrong about it.
 *
 * Brier score and log loss (section 2) are computed on that SAME
 * per-market, winning-outcome-only figure: brier = mean((model_prob-1)^2)
 * across scored markets, log_loss = mean(-ln(model_prob)) (probabilities
 * clipped to [LOG_LOSS_EPSILON, 1-LOG_LOSS_EPSILON] to avoid -Infinity on
 * an exact 0). This is the standard "score on the probability assigned to
 * what actually happened" convention (the same one prediction-market and
 * forecasting-tournament scoring uses), and it is internally consistent
 * with section 1's per-market errors: brier_i = model_error_i^2. It is NOT
 * the traditional multiclass Brier score summed over every outcome of
 * every market, which would need a full per-outcome market price vector
 * this project's resolutions.json schema does not provide (only the
 * winning outcome's price).
 *
 * The RELIABILITY CURVE (section 2) is the one place this report uses
 * BOTH outcomes of every resolved market, not just the winner: for a
 * bucket like [0.6, 0.7) to mean anything ("of the times the model said
 * 60-70%, how often did it actually happen"), each bucket needs a mix of
 * eventually-true and eventually-false predictions. Using only
 * winning-outcome rows (always actual=1) would make every bucket show
 * 100% trivially. So this curve pairs EVERY result.outcomes[i].probability
 * in every resolved market with actual_i = 1 if i is the resolved outcome
 * index, else 0, and buckets those. This needs no market price, so it
 * covers every resolved+forecast market regardless of whether
 * marketPriceAtResolution was supplied. There is no equivalent market
 * reliability curve in this report: that would need a market price for
 * every outcome of every market, not just the winning one, which
 * resolutions.json as specified does not carry.
 *
 * The LARGE EDGE breakdown (section 3) uses the same per-market,
 * winning-outcome (model_prob, market_prob) pair as section 1:
 * edge = model_prob - market_prob for the outcome that happened.
 * |edge| > LARGE_EDGE_THRESHOLD (default 0.25) and edge > 0 is counted as
 * "model's favor" (the model was more confident than the market in what
 * turned out to be true). edge < 0 is "market's favor" (the market was
 * more confident than the model in what turned out to be true, i.e. the
 * model's skepticism of the true outcome was wrong). This can only see
 * disagreement ABOUT THE OUTCOME THAT HAPPENED: it cannot detect a large
 * edge the model claimed on a DIFFERENT, losing outcome (that would need
 * per-outcome market prices this report does not have). Markets missing
 * marketPriceAtResolution are excluded from this specific breakdown, since
 * edge cannot be computed without a market price.
 *
 * Usage:
 *   npx tsx scripts/calibration-report.ts \
 *     --state <path-to-a-COPY-of-agent-state.json> \
 *     --resolutions <path-to-resolutions.json> \
 *     [--out-json reports/calibration.json] \
 *     [--out-csv reports/calibration.csv]
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { classifyDomain } from "../src/markets/classify.js";

const LOG_LOSS_EPSILON = 1e-6;
const LARGE_EDGE_THRESHOLD = 0.25;
const RELIABILITY_BUCKET_WIDTH = 0.1;

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
  subject?: string;
  condition?: string;
  comparatorOrThreshold?: string | null;
  sourceOfTruth?: string | null;
}

interface StateFileShape {
  forecastCache?: Record<string, CacheEntryShape>;
}

interface ResolutionEntry {
  marketAddress?: string;
  question?: string;
  resolvedOutcome: string | number;
  marketPriceAtResolution?: number;
  volume?: number;
}

// ---------- parsed / matched record ----------

interface ForecastRecord {
  marketAddress: string;
  question: string;
  outcomes: string[];
  domain: string;
  evidenceQuality: string;
  hasEvidence: boolean;
  sourcesUsedCount: number;
  baseRate: number | null;
  cachedAtMs: number;
  rawOutcomes: OutcomeEstimate[];
}

interface ScoredMarket {
  marketAddress: string;
  question: string;
  domain: string;
  hasEvidence: boolean;
  resolvedOutcomeIdx: number;
  resolvedOutcomeLabel: string;
  modelProb: number | null;
  marketProb: number | null;
  modelError: number | null;
  marketError: number | null;
  volume: number | null;
}

interface UnresolvedMarket {
  marketAddress: string;
  question: string;
  reason: string;
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

// ---------- loading + parsing ----------

async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as T;
}

function normalizeQuestion(q: string): string {
  return q.trim().replace(/\s+/g, " ");
}

function parseForecastCache(state: StateFileShape): { records: ForecastRecord[]; parseErrors: string[] } {
  const records: ForecastRecord[] = [];
  const parseErrors: string[] = [];
  const entries = Object.entries(state.forecastCache ?? {});

  for (const [marketAddress, entry] of entries) {
    let parsedHash: ParsedInputHash;
    try {
      parsedHash = JSON.parse(entry.inputHash) as ParsedInputHash;
    } catch {
      parseErrors.push(`${marketAddress}: inputHash is not valid JSON, skipped entirely`);
      continue;
    }
    if (!Array.isArray(parsedHash.outcomes) || typeof parsedHash.question !== "string") {
      parseErrors.push(`${marketAddress}: inputHash missing question/outcomes, skipped entirely`);
      continue;
    }
    if (!entry.result || !Array.isArray(entry.result.outcomes)) {
      parseErrors.push(`${marketAddress}: cache entry has no valid result.outcomes, skipped entirely`);
      continue;
    }

    const sourcesUsedCount = entry.result.sourcesUsed?.length ?? 0;
    const evidenceQuality = entry.result.evidenceQuality ?? "unspecified";
    const hasEvidence = sourcesUsedCount > 0 && evidenceQuality !== "none";

    records.push({
      marketAddress,
      question: parsedHash.question,
      outcomes: parsedHash.outcomes,
      domain: classifyDomain("", parsedHash.question),
      evidenceQuality,
      hasEvidence,
      sourcesUsedCount,
      baseRate: typeof entry.result.baseRate === "number" ? entry.result.baseRate : null,
      cachedAtMs: entry.cachedAtMs,
      rawOutcomes: entry.result.outcomes,
    });
  }

  return { records, parseErrors };
}

function resolveOutcomeIndex(resolution: ResolutionEntry, outcomes: string[]): number | null {
  if (typeof resolution.resolvedOutcome === "number") {
    return Number.isInteger(resolution.resolvedOutcome) && resolution.resolvedOutcome >= 0 && resolution.resolvedOutcome < outcomes.length
      ? resolution.resolvedOutcome
      : null;
  }
  const target = resolution.resolvedOutcome.trim().toLowerCase();
  const idx = outcomes.findIndex((o) => o.trim().toLowerCase() === target);
  return idx === -1 ? null : idx;
}

function clipProb(p: number): number {
  return Math.min(1 - LOG_LOSS_EPSILON, Math.max(LOG_LOSS_EPSILON, p));
}

// ---------- matching + scoring ----------

function matchAndScore(
  records: ForecastRecord[],
  resolutions: ResolutionEntry[]
): {
  scored: ScoredMarket[];
  unresolved: UnresolvedMarket[];
  matchErrors: string[];
  reliabilityRows: Array<{ prob: number; actual: 0 | 1 }>;
  unmatchedResolutions: ResolutionEntry[];
} {
  const byAddress = new Map<string, ResolutionEntry>();
  const byQuestion = new Map<string, ResolutionEntry>();
  for (const r of resolutions) {
    if (r.marketAddress) byAddress.set(r.marketAddress.toLowerCase(), r);
    if (r.question) byQuestion.set(normalizeQuestion(r.question).toLowerCase(), r);
  }

  const usedResolutions = new Set<ResolutionEntry>();
  const scored: ScoredMarket[] = [];
  const unresolved: UnresolvedMarket[] = [];
  const matchErrors: string[] = [];
  const reliabilityRows: Array<{ prob: number; actual: 0 | 1 }> = [];

  for (const rec of records) {
    const resolution = byAddress.get(rec.marketAddress.toLowerCase()) ?? byQuestion.get(normalizeQuestion(rec.question).toLowerCase());

    if (!resolution) {
      unresolved.push({ marketAddress: rec.marketAddress, question: rec.question, reason: "no matching entry in resolutions file" });
      continue;
    }
    usedResolutions.add(resolution);

    const resolvedIdx = resolveOutcomeIndex(resolution, rec.outcomes);
    if (resolvedIdx === null) {
      matchErrors.push(
        `${rec.marketAddress} (${rec.question}): resolvedOutcome "${String(resolution.resolvedOutcome)}" does not match any of this market's outcomes [${rec.outcomes.join(", ")}], excluded from scoring`
      );
      unresolved.push({ marketAddress: rec.marketAddress, question: rec.question, reason: "resolvedOutcome did not match any known outcome label/index" });
      continue;
    }

    // Reliability curve: every outcome of this market, model prob paired with whether that outcome is the one that happened.
    rec.rawOutcomes.forEach((o, i) => {
      if (o.probability !== null) reliabilityRows.push({ prob: o.probability, actual: i === resolvedIdx ? 1 : 0 });
    });

    const modelProb = rec.rawOutcomes[resolvedIdx]?.probability ?? null;
    const marketProb = typeof resolution.marketPriceAtResolution === "number" ? resolution.marketPriceAtResolution : null;

    scored.push({
      marketAddress: rec.marketAddress,
      question: rec.question,
      domain: rec.domain,
      hasEvidence: rec.hasEvidence,
      resolvedOutcomeIdx: resolvedIdx,
      resolvedOutcomeLabel: rec.outcomes[resolvedIdx] ?? String(resolvedIdx),
      modelProb,
      marketProb,
      modelError: modelProb === null ? null : modelProb - 1,
      marketError: marketProb === null ? null : marketProb - 1,
      volume: typeof resolution.volume === "number" ? resolution.volume : null,
    });
  }

  const unmatchedResolutions = resolutions.filter((r) => !usedResolutions.has(r));

  return { scored, unresolved, matchErrors, reliabilityRows, unmatchedResolutions };
}

// ---------- aggregate metrics ----------

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

function brierAndLogLoss(errors: Array<{ prob: number }>): { brier: number | null; logLoss: number | null; n: number } {
  const probs = errors.map((e) => e.prob).filter((p): p is number => p !== null && !Number.isNaN(p));
  if (probs.length === 0) return { brier: null, logLoss: null, n: 0 };
  const brier = mean(probs.map((p) => (p - 1) ** 2));
  const logLoss = mean(probs.map((p) => -Math.log(clipProb(p))));
  return { brier, logLoss, n: probs.length };
}

interface ReliabilityBucket {
  bucketLabel: string;
  bucketLow: number;
  bucketHigh: number;
  n: number;
  meanPredicted: number | null;
  actualFrequency: number | null;
}

function buildReliabilityCurve(rows: Array<{ prob: number; actual: 0 | 1 }>): ReliabilityBucket[] {
  // Integer bucket count, not float accumulation: RELIABILITY_BUCKET_WIDTH
  // like 0.1 does not divide 1 exactly in floating point (0 + 0.1 ten times
  // lands on 0.9999999999999999, not 1), which used to produce a spurious
  // eleventh, empty "100-100%" bucket.
  const bucketCount = Math.round(1 / RELIABILITY_BUCKET_WIDTH);
  const buckets: ReliabilityBucket[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const low = i / bucketCount;
    const high = (i + 1) / bucketCount;
    const inBucket = rows.filter((r) => (i === 0 ? r.prob >= low : r.prob > low) && r.prob <= high);
    buckets.push({
      bucketLabel: `${(low * 100).toFixed(0)}-${(high * 100).toFixed(0)}%`,
      bucketLow: low,
      bucketHigh: high,
      n: inBucket.length,
      meanPredicted: mean(inBucket.map((r) => r.prob)),
      actualFrequency: mean(inBucket.map((r) => r.actual)),
    });
  }
  return buckets;
}

interface GroupSummary {
  n: number;
  brier: number | null;
  logLoss: number | null;
  meanModelError: number | null;
  meanMarketError: number | null;
}

function summarizeGroup(markets: ScoredMarket[]): GroupSummary {
  const withModelProb = markets.filter((m) => m.modelProb !== null).map((m) => ({ prob: m.modelProb! }));
  const { brier, logLoss } = brierAndLogLoss(withModelProb);
  return {
    n: markets.length,
    brier,
    logLoss,
    meanModelError: mean(markets.filter((m) => m.modelError !== null).map((m) => m.modelError!)),
    meanMarketError: mean(markets.filter((m) => m.marketError !== null).map((m) => m.marketError!)),
  };
}

interface LargeEdgeResult {
  threshold: number;
  totalWithMarketPrice: number;
  largeEdgeCount: number;
  modelsFavor: number;
  marketsFavor: number;
  markets: Array<{ marketAddress: string; question: string; edge: number; favor: "model" | "market" }>;
}

function largeEdgeBreakdown(markets: ScoredMarket[]): LargeEdgeResult {
  const withPrice = markets.filter((m) => m.modelProb !== null && m.marketProb !== null);
  const large = withPrice
    .map((m) => ({ m, edge: m.modelProb! - m.marketProb! }))
    .filter(({ edge }) => Math.abs(edge) > LARGE_EDGE_THRESHOLD);

  const rows = large.map(({ m, edge }) => ({
    marketAddress: m.marketAddress,
    question: m.question,
    edge,
    favor: (edge > 0 ? "model" : "market") as "model" | "market",
  }));

  return {
    threshold: LARGE_EDGE_THRESHOLD,
    totalWithMarketPrice: withPrice.length,
    largeEdgeCount: rows.length,
    modelsFavor: rows.filter((r) => r.favor === "model").length,
    marketsFavor: rows.filter((r) => r.favor === "market").length,
    markets: rows,
  };
}

// ---------- report assembly ----------

function fmt(n: number | null, digits = 4): string {
  return n === null ? "n/a" : n.toFixed(digits);
}

function buildSummaryParagraph(
  overall: GroupSummary,
  evidenceGroups: { withEvidence: GroupSummary; noEvidence: GroupSummary },
  largeEdge: LargeEdgeResult,
  unresolvedCount: number,
  scoredCount: number
): string {
  const parts: string[] = [];
  parts.push(`Scored ${scoredCount} resolved markets (${unresolvedCount} cached forecasts had no matching resolution and were excluded).`);
  if (overall.brier !== null) {
    const marketBrier = overall.meanMarketError !== null ? overall.meanMarketError ** 2 : null;
    if (marketBrier !== null) {
      const worse = overall.brier > marketBrier;
      parts.push(
        `Model Brier score was ${fmt(overall.brier)} versus the market's ${fmt(marketBrier)}, meaning the model was ${worse ? "worse" : "better"} calibrated than simply trusting the market price on this sample.`
      );
    } else {
      parts.push(`Model Brier score was ${fmt(overall.brier)}; market price was not available for enough markets to compute a comparable market Brier score.`);
    }
  }
  if (evidenceGroups.withEvidence.brier !== null && evidenceGroups.noEvidence.brier !== null) {
    const evidenceWorse = evidenceGroups.noEvidence.brier > evidenceGroups.withEvidence.brier;
    parts.push(
      `Forecasts with no retrieved evidence (n=${evidenceGroups.noEvidence.n}, Brier ${fmt(evidenceGroups.noEvidence.brier)}) were ${evidenceWorse ? "worse" : "not worse"} than forecasts with real evidence attached (n=${evidenceGroups.withEvidence.n}, Brier ${fmt(evidenceGroups.withEvidence.brier)}).`
    );
  }
  if (largeEdge.largeEdgeCount > 0) {
    parts.push(
      `Of ${largeEdge.largeEdgeCount} markets where the model and market disagreed by more than ${largeEdge.threshold} on the outcome that happened, the market's side won ${largeEdge.marketsFavor} time(s) and the model's side won ${largeEdge.modelsFavor} time(s).`
    );
  } else {
    parts.push(`No markets in this sample had a model/market disagreement larger than ${largeEdge.threshold} on the outcome that happened.`);
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

  const { records, parseErrors } = parseForecastCache(state);
  const { scored, unresolved, matchErrors, reliabilityRows, unmatchedResolutions } = matchAndScore(records, resolutions);

  const overall = summarizeGroup(scored);
  const withEvidence = summarizeGroup(scored.filter((m) => m.hasEvidence));
  const noEvidence = summarizeGroup(scored.filter((m) => !m.hasEvidence));

  const byDomain = new Map<string, ScoredMarket[]>();
  for (const m of scored) {
    const list = byDomain.get(m.domain) ?? [];
    list.push(m);
    byDomain.set(m.domain, list);
  }
  const domainBreakdown: Record<string, GroupSummary> = {};
  for (const [domain, markets] of byDomain) domainBreakdown[domain] = summarizeGroup(markets);

  const reliability = buildReliabilityCurve(reliabilityRows);
  const largeEdge = largeEdgeBreakdown(scored);
  const marketOverallBrier = overall.meanMarketError !== null ? overall.meanMarketError ** 2 : null;
  const marketLogLoss = brierAndLogLoss(scored.filter((m) => m.marketProb !== null).map((m) => ({ prob: m.marketProb! }))).logLoss;

  const summaryParagraph = buildSummaryParagraph(overall, { withEvidence, noEvidence }, largeEdge, unresolved.length, scored.length);

  const report = {
    generatedAtMs: null as number | null, // filled by caller if needed; not using Date.now() here keeps this script's output reproducible byte-for-byte on rerun against unchanged inputs
    inputs: { statePath, resolutionsPath },
    counts: {
      totalCachedForecasts: records.length,
      scoredMarkets: scored.length,
      unresolvedMarkets: unresolved.length,
      unmatchedResolutionEntries: unmatchedResolutions.length,
      parseErrors: parseErrors.length,
      matchErrors: matchErrors.length,
    },
    perMarket: scored,
    unresolved,
    unmatchedResolutions,
    parseErrors,
    matchErrors,
    aggregate: {
      model: { brier: overall.brier, logLoss: overall.logLoss, n: overall.n },
      market: { brier: marketOverallBrier, logLoss: marketLogLoss, n: scored.filter((m) => m.marketProb !== null).length },
    },
    reliabilityCurve: reliability,
    biasBreakdown: {
      byEvidence: { withEvidence, noEvidence },
      byDomain: domainBreakdown,
      largeEdge,
    },
    summary: summaryParagraph,
  };

  await mkdir(dirname(outJson), { recursive: true });
  await writeFile(outJson, JSON.stringify(report, null, 2), "utf8");

  const csvLines = [
    "marketAddress,question,domain,hasEvidence,resolvedOutcomeLabel,modelProb,marketProb,actual,modelError,marketError,volume",
  ];
  for (const m of scored) {
    const escapedQuestion = `"${m.question.replace(/"/g, '""')}"`;
    csvLines.push(
      [m.marketAddress, escapedQuestion, m.domain, m.hasEvidence, m.resolvedOutcomeLabel, fmt(m.modelProb), fmt(m.marketProb), 1, fmt(m.modelError), fmt(m.marketError), m.volume ?? ""].join(",")
    );
  }
  await mkdir(dirname(outCsv), { recursive: true });
  await writeFile(outCsv, csvLines.join("\n") + "\n", "utf8");

  console.log("=== Calibration report ===");
  console.log(`State file: ${statePath}`);
  console.log(`Resolutions file: ${resolutionsPath}`);
  console.log("");
  console.log(`Cached forecasts: ${records.length}`);
  console.log(`Scored (resolved + matched): ${scored.length}`);
  console.log(`Unresolved (no matching resolution or bad outcome match): ${unresolved.length}`);
  console.log(`Unmatched resolutions.json entries (no cached forecast found): ${unmatchedResolutions.length}`);
  if (parseErrors.length > 0) {
    console.log("");
    console.log("Parse errors:");
    for (const e of parseErrors) console.log(`  - ${e}`);
  }
  if (matchErrors.length > 0) {
    console.log("");
    console.log("Match errors:");
    for (const e of matchErrors) console.log(`  - ${e}`);
  }
  console.log("");
  console.log("--- Aggregate calibration (winning-outcome convention, see script header) ---");
  console.log(`Model:  Brier=${fmt(overall.brier)}  logLoss=${fmt(overall.logLoss)}  n=${overall.n}`);
  console.log(`Market: Brier=${fmt(marketOverallBrier)}  logLoss=${fmt(marketLogLoss)}  n=${scored.filter((m) => m.marketProb !== null).length}`);
  console.log("");
  console.log("--- Reliability curve (model, both outcomes of every resolved market) ---");
  console.log("bucket        n    mean_predicted   actual_frequency");
  for (const b of reliability) {
    console.log(`${b.bucketLabel.padEnd(12)}  ${String(b.n).padStart(3)}   ${fmt(b.meanPredicted, 3).padStart(14)}   ${fmt(b.actualFrequency, 3).padStart(16)}`);
  }
  console.log("");
  console.log("--- Bias: evidence vs none ---");
  console.log(`With evidence: n=${withEvidence.n}  Brier=${fmt(withEvidence.brier)}  logLoss=${fmt(withEvidence.logLoss)}  meanModelError=${fmt(withEvidence.meanModelError)}`);
  console.log(`No evidence:   n=${noEvidence.n}  Brier=${fmt(noEvidence.brier)}  logLoss=${fmt(noEvidence.logLoss)}  meanModelError=${fmt(noEvidence.meanModelError)}`);
  console.log("");
  console.log("--- Bias: by domain (best-effort, keyword-classified from question text) ---");
  for (const [domain, s] of Object.entries(domainBreakdown)) {
    console.log(`${domain.padEnd(14)} n=${s.n}  Brier=${fmt(s.brier)}  logLoss=${fmt(s.logLoss)}  meanModelError=${fmt(s.meanModelError)}`);
  }
  console.log("");
  console.log(`--- Large edge (|model_prob - market_prob| > ${largeEdge.threshold}, on the outcome that happened) ---`);
  console.log(`Markets with a market price: ${largeEdge.totalWithMarketPrice}`);
  console.log(`Large edge count: ${largeEdge.largeEdgeCount}`);
  console.log(`Model's favor: ${largeEdge.modelsFavor}`);
  console.log(`Market's favor: ${largeEdge.marketsFavor}`);
  for (const r of largeEdge.markets) {
    console.log(`  - ${r.marketAddress} edge=${r.edge.toFixed(4)} favor=${r.favor} (${r.question})`);
  }
  console.log("");
  console.log("--- Summary ---");
  console.log(summaryParagraph);
  console.log("");
  console.log(`Wrote ${outJson}`);
  console.log(`Wrote ${outCsv}`);
}

main().catch((err) => {
  console.error("calibration-report failed:", err);
  process.exitCode = 1;
});
