/**
 * LLM-based forecasting for markets with no confident (high-quality)
 * consensus reference. Prompt is a calibration-first forecaster: base rate
 * before adjustment, evidence-weighted, explicitly forecasting the
 * STRUCTURED resolution criteria (not a loose reading of the question), and
 * never anchored on the market price.
 *
 * Returns null — not a fabricated guess — when the LLM is unconfigured, the
 * call/parse fails twice in a row, or the provider is rate-limited even
 * after backoff (llmClient.ts retries 429s internally; a persistent 429
 * here means "defer this market to the next pass" — returning null and
 * letting the loop move on already does that, no special-casing needed, but
 * see getLastForecastStatus() for reporting which case happened).
 *
 * Malformed JSON gets exactly ONE retry (a fresh LLM call, not a re-parse of
 * the same text) before giving up — never a guess past that.
 *
 * Caches by a hash of the inputs that would actually change the answer
 * (question, outcomes, resolvesAt, structured fields) so a market whose
 * inputs haven't changed since the last pass is NOT re-forecast — this
 * matters a lot against Groq's free-tier rate limits (30 req/min). F2 adds
 * a second, independent trigger: even with UNCHANGED inputs, a cached
 * result older than forecastBudget.forecastStalenessMinutes is treated as
 * stale and re-forecast — the world can move without the question text
 * changing (e.g. new evidence appearing). Re-forecasting happens on input
 * change OR staleness, not on every loop pass.
 *
 * Per-outcome nulls are allowed by the prompt contract (the model may only
 * be able to estimate some outcomes) — that maps directly onto
 * signals/types.ts's OutcomeEstimate, which was already designed to allow a
 * partial per-outcome distribution.
 */
import type { NormalizedMarket } from "../../markets/types.js";
import type { StructuredResolution, ForecastResult } from "./types.js";
import type { OutcomeEstimate } from "../types.js";
import { isLLMConfigured, callLLM, extractJson, getLastLLMCallStatus, getLastTokensUsed, type LLMCallStatus } from "./llmClient.js";
import { isSearchConfigured, search } from "./searchProvider.js";
import { recordTokenUsage, throttleForRateLimit, ESTIMATED_TOKENS_PER_FORECAST } from "./tokenBudget.js";
import { forecastBudget } from "../../config/index.js";

const TEMPERATURE = 0.2;
const SUM_TOLERANCE = 0.05;
const MALFORMED_JSON_RETRIES = 1;

// Evidence trimming (Phase 5 carry-forward correction): cap how much search
// context rides in each prompt, keeping calls lean and predictable for the
// per-minute token-rate limiter below.
const MAX_EVIDENCE_ITEMS = 3;
const MAX_SNIPPET_CHARS = 300;

const SYSTEM_PROMPT = `You are a calibrated forecasting engine for prediction markets. Your only job is
to estimate the true probability of each outcome as accurately and honestly as
possible. You are scored on CALIBRATION: when you say 70%, it should happen about
70% of the time. Overconfidence is the cardinal sin. If you lack evidence, report
low confidence rather than inventing a confident number.

Method, in this order:
1. Identify the reference class and its base rate BEFORE looking at case
   specifics. State the base rate you start from.
2. Adjust from that base rate using only the case-specific evidence provided.
   Move only as far as the evidence justifies.
3. Consider both what would make each outcome happen and what would prevent it.
4. Forecast EXACTLY the structured resolution criteria (subject, condition,
   threshold, source of truth, resolution time), not a general impression of the
   question. If the criteria are ambiguous, lower confidence and say so.
5. Weight evidence by recency and source authority. If evidence is absent, stale,
   or thin, stay near the base rate and lower confidence.
6. Do NOT anchor on any market price. Form an independent estimate.

Calibration rules:
- Reserve probabilities near 0 or 1 for outcomes that are near-certain on strong
  evidence. Otherwise stay away from the extremes.
- confidence reflects how much reliable evidence supports the estimate, NOT how
  likely the outcome is.
- Never fabricate facts, sources, or figures. Unknown means low confidence.`;

interface RawForecastResponse {
  baseRate?: number;
  outcomes?: Array<{ label?: string; probability?: number | null; confidence?: number }>;
  reasoning?: string;
  keyDrivers?: string[];
  resolutionRisk?: string;
  evidenceQuality?: string;
}

function buildUserPrompt(market: NormalizedMarket, structured: StructuredResolution, searchContext: string): string {
  return `MARKET
Question: ${market.question}
Outcomes: ${JSON.stringify(market.outcomes)}
Structured resolution:
  subject: ${structured.subject}
  condition: ${structured.condition}
  threshold/comparator: ${structured.comparatorOrThreshold ?? "none stated"}
  source of truth: ${structured.sourceOfTruth ?? "none stated"}
  resolves at: ${structured.resolutionTime ?? "unknown"}
Current time: ${new Date().toISOString()}

EVIDENCE (retrieved; may be empty)
${searchContext}

TASK
Estimate the probability of each listed outcome. Return ONLY this JSON, nothing
else:
{
  "baseRate": <0-1, the reference-class rate you started from for the primary outcome>,
  "outcomes": [
    { "label": "<label>", "probability": <0-1 or null>, "confidence": <0-1> }
  ],
  "reasoning": "<2-4 sentences: reference class, main adjustment, why>",
  "keyDrivers": ["<short factor>", "..."],
  "resolutionRisk": "<ambiguity in how this resolves, or 'low'>",
  "evidenceQuality": "strong | moderate | thin | none"
}
Rules: one entry per listed outcome in the given order. Mutually-exclusive,
exhaustive outcomes should sum to ~1. If you can only estimate some outcomes, set
the rest to null and lower confidence accordingly. No text outside the JSON.`;
}

const EVIDENCE_QUALITIES = new Set(["strong", "moderate", "thin", "none"]);

function parseAndValidate(text: string, outcomeCount: number): ForecastResult | null {
  const parsed = extractJson<RawForecastResponse>(text);
  if (!parsed || !Array.isArray(parsed.outcomes)) return null;
  if (parsed.outcomes.length !== outcomeCount) return null;

  const outcomes: OutcomeEstimate[] = [];
  for (const o of parsed.outcomes) {
    if (o.probability !== null && o.probability !== undefined) {
      if (typeof o.probability !== "number" || o.probability < 0 || o.probability > 1 || Number.isNaN(o.probability)) return null;
    }
    if (typeof o.confidence !== "number" || o.confidence < 0 || o.confidence > 1 || Number.isNaN(o.confidence)) return null;
    outcomes.push({ probability: o.probability ?? null, confidence: o.confidence });
  }

  // Only enforce/renormalize sum-to-1 when every outcome was actually estimated —
  // the prompt explicitly allows partial distributions (some outcomes null).
  if (outcomes.every((o) => o.probability !== null)) {
    const sum = outcomes.reduce((a, o) => a + o.probability!, 0);
    if (Math.abs(sum - 1) > SUM_TOLERANCE) return null;
    for (const o of outcomes) o.probability = o.probability! / sum;
  }

  if (typeof parsed.baseRate === "number" && (parsed.baseRate < 0 || parsed.baseRate > 1)) return null;
  const evidenceQuality =
    typeof parsed.evidenceQuality === "string" && EVIDENCE_QUALITIES.has(parsed.evidenceQuality)
      ? (parsed.evidenceQuality as ForecastResult["evidenceQuality"])
      : undefined;

  return {
    outcomes,
    rationale: parsed.reasoning ?? "",
    sourcesUsed: [],
    baseRate: parsed.baseRate,
    keyDrivers: Array.isArray(parsed.keyDrivers) ? parsed.keyDrivers.filter((k) => typeof k === "string") : undefined,
    resolutionRisk: typeof parsed.resolutionRisk === "string" ? parsed.resolutionRisk : undefined,
    evidenceQuality,
  };
}

export interface CacheEntry {
  inputHash: string;
  result: ForecastResult;
  cachedAtMs: number;
}
const cache = new Map<string, CacheEntry>();

/** For F2's staleness ranking (forecastGovernor.ts) — null if never forecast. */
export function getLastForecastTimeMs(marketAddress: string): number | null {
  return cache.get(marketAddress)?.cachedAtMs ?? null;
}

/** For persistence/index.ts. Persists cachedAtMs (per-market last-forecast timestamp, required durable) alongside the full result — restoring the result too avoids a wasted re-forecast immediately after restart when the cache is still fresh. */
export function exportForecastCache(): Record<string, CacheEntry> {
  return Object.fromEntries(cache);
}

/** For persistence/index.ts, on startup load. */
export function importForecastCache(data: Record<string, CacheEntry>): void {
  for (const [address, entry] of Object.entries(data)) {
    cache.set(address, entry);
  }
}

function hashInputs(market: NormalizedMarket, structured: StructuredResolution): string {
  return JSON.stringify({
    question: market.question,
    outcomes: market.outcomes,
    resolvesAt: market.resolvesAt?.toISOString() ?? null,
    subject: structured.subject,
    condition: structured.condition,
    comparatorOrThreshold: structured.comparatorOrThreshold,
    sourceOfTruth: structured.sourceOfTruth,
  });
}

/** Last forecastProbability() outcome, for reporting only (print-signals/paper-run) — mirrors llmClient's getLastLLMCallStatus but distinguishes "served from cache" and "malformed JSON after retry". */
export type ForecastOutcomeStatus = LLMCallStatus | "cached" | "parse_failed";
let lastOutcomeStatus: ForecastOutcomeStatus | null = null;
export function getLastForecastStatus(): ForecastOutcomeStatus | null {
  return lastOutcomeStatus;
}

export async function forecastProbability(
  market: NormalizedMarket,
  structured: StructuredResolution
): Promise<ForecastResult | null> {
  if (!isLLMConfigured()) {
    lastOutcomeStatus = "unconfigured";
    return null;
  }

  const inputHash = hashInputs(market, structured);
  const cached = cache.get(market.address);
  const stalenessMs = forecastBudget.forecastStalenessMinutes * 60_000;
  const isStale = cached ? Date.now() - cached.cachedAtMs >= stalenessMs : true;
  if (cached && cached.inputHash === inputHash && !isStale) {
    lastOutcomeStatus = "cached";
    return cached.result;
  }

  let searchContext = "none available";
  let sourcesUsed: string[] = [];
  if (isSearchConfigured()) {
    const results = await search(market.question);
    if (results && results.length > 0) {
      // Evidence trimming (Phase 5 carry-forward correction): top-N only, each snippet capped — keeps every call lean and predictable for the per-minute rate limiter below.
      const trimmed = results.slice(0, MAX_EVIDENCE_ITEMS);
      searchContext = trimmed.map((r) => `- ${r.title} (${r.url}): ${r.snippet.slice(0, MAX_SNIPPET_CHARS)}`).join("\n");
      sourcesUsed = trimmed.map((r) => r.url);
    } else {
      searchContext = "none available (search configured but returned no results)";
    }
  }

  const userPrompt = buildUserPrompt(market, structured, searchContext);

  // Per-minute pacing (Phase 5 carry-forward correction): Groq's binding
  // limit is 12k tokens/MIN, not the daily figure — this can genuinely
  // sleep to stay under it with margin, before spending the call.
  await throttleForRateLimit(ESTIMATED_TOKENS_PER_FORECAST);
  let text = await callLLM(SYSTEM_PROMPT, userPrompt, { temperature: TEMPERATURE });
  const callStatus = getLastLLMCallStatus();
  const tokensUsed1 = getLastTokensUsed();
  if (tokensUsed1 !== null) recordTokenUsage(tokensUsed1);
  if (!text) {
    // Network/config/rate-limit failure — already retried at the network layer (backoff). Not the "malformed JSON" case.
    lastOutcomeStatus = callStatus ?? "error";
    return null;
  }

  let result = parseAndValidate(text, market.outcomeCount);

  if (!result) {
    // Malformed JSON — retry once with a fresh call, per instruction. Never guess past this.
    for (let attempt = 0; attempt < MALFORMED_JSON_RETRIES && !result; attempt++) {
      await throttleForRateLimit(ESTIMATED_TOKENS_PER_FORECAST);
      text = await callLLM(SYSTEM_PROMPT, userPrompt, { temperature: TEMPERATURE });
      const tokensUsed2 = getLastTokensUsed();
      if (tokensUsed2 !== null) recordTokenUsage(tokensUsed2);
      if (!text) {
        lastOutcomeStatus = getLastLLMCallStatus() ?? "error";
        return null;
      }
      result = parseAndValidate(text, market.outcomeCount);
    }
    if (!result) {
      lastOutcomeStatus = "parse_failed";
      return null;
    }
  }

  result.sourcesUsed = sourcesUsed;
  cache.set(market.address, { inputHash, result, cachedAtMs: Date.now() });
  lastOutcomeStatus = "ok";
  return result;
}
