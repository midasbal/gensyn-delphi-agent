/**
 * LLM-based forecasting for markets with no confident (high-quality)
 * consensus reference. Base-rate-first: the prompt explicitly asks the model
 * to anchor on a base rate before adjusting for specifics, and to use
 * retrieved search snippets (if any) over its own training knowledge for
 * anything time-sensitive.
 *
 * Returns null — not a fabricated guess — when the LLM is unconfigured, the
 * call/parse fails, OR the provider is rate-limited even after backoff
 * (llmClient.ts retries 429s internally; a persistent 429 here means "defer
 * this market to the next pass", which is exactly what returning null and
 * letting the loop move on already does — no special-casing needed at this
 * layer, but see getLastLLMCallStatus() for reporting which case happened).
 *
 * Caches by a hash of the inputs that would actually change the answer
 * (question, outcomes, resolvesAt, structured fields) so a market whose
 * inputs haven't changed since the last pass is NOT re-forecast — this
 * matters a lot against Groq's free-tier rate limits (30 req/min).
 *
 * Asks for a probability per outcome (not just outcomes[0]) so this works
 * for N-outcome markets, not just binary — see signals/types.ts.
 */
import type { NormalizedMarket } from "../../markets/types.js";
import type { StructuredResolution, ForecastResult } from "./types.js";
import type { OutcomeEstimate } from "../types.js";
import { isLLMConfigured, callLLM, extractJson, getLastLLMCallStatus, type LLMCallStatus } from "./llmClient.js";
import { isSearchConfigured, search } from "./searchProvider.js";

const SYSTEM_PROMPT = `You are forecasting probabilities for a prediction-market's outcomes.
Reason base-rate first: start from the historical base rate for this class of event, then adjust for the specifics given. Prefer any provided search snippets over your own training knowledge for anything time-sensitive — your training data may be stale.
Respond with ONLY a JSON object:
{
  "probabilities": [<number 0-1 for outcomes[0]>, <number 0-1 for outcomes[1]>, ...],
  "confidence": <number 0-1, your overall confidence in this distribution>,
  "rationale": "<2-4 sentences: base rate, then adjustment, then any search evidence used>"
}
The probabilities array MUST have exactly one entry per outcome, in the given order, and MUST sum to approximately 1.
Do not include any text outside the JSON object.`;

const SUM_TOLERANCE = 0.05;

const cache = new Map<string, { inputHash: string; result: ForecastResult }>();

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

/** Last forecastProbability() outcome, for reporting only (print-signals/paper-run) — mirrors llmClient's getLastLLMCallStatus but distinguishes "served from cache". */
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
  if (cached && cached.inputHash === inputHash) {
    lastOutcomeStatus = "cached";
    return cached.result;
  }

  let sourcesUsed: string[] = [];
  let searchContext = "(no live search configured)";
  if (isSearchConfigured()) {
    const results = await search(market.question);
    if (results && results.length > 0) {
      sourcesUsed = results.map((r) => r.url);
      searchContext = results.map((r) => `- ${r.title}: ${r.snippet} (${r.url})`).join("\n");
    } else {
      searchContext = "(search configured but returned no results)";
    }
  }

  const userPrompt = [
    `Question: ${market.question}`,
    `Outcomes (in order): ${JSON.stringify(market.outcomes)}`,
    `Subject: ${structured.subject}`,
    `Condition: ${structured.condition}`,
    structured.comparatorOrThreshold ? `Threshold: ${structured.comparatorOrThreshold}` : null,
    `Resolves at: ${structured.resolutionTime ?? "unknown"}`,
    `Search results:\n${searchContext}`,
  ]
    .filter(Boolean)
    .join("\n");

  const text = await callLLM(SYSTEM_PROMPT, userPrompt);
  const callStatus = getLastLLMCallStatus();
  if (!text) {
    // Rate-limited or errored — deliberately NOT cached, so the next pass retries with fresh inputs.
    lastOutcomeStatus = callStatus ?? "error";
    return null;
  }

  const parsed = extractJson<{ probabilities?: number[]; confidence?: number; rationale?: string }>(text);
  if (!parsed || !Array.isArray(parsed.probabilities) || typeof parsed.confidence !== "number") {
    lastOutcomeStatus = "parse_failed";
    return null;
  }
  if (parsed.probabilities.length !== market.outcomeCount) {
    lastOutcomeStatus = "parse_failed";
    return null;
  }
  if (parsed.probabilities.some((p) => typeof p !== "number" || p < 0 || p > 1 || Number.isNaN(p))) {
    lastOutcomeStatus = "parse_failed";
    return null;
  }

  const sum = parsed.probabilities.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > SUM_TOLERANCE) {
    lastOutcomeStatus = "parse_failed";
    return null;
  }

  const confidence = Math.min(1, Math.max(0, parsed.confidence));
  // Renormalize to exactly 1 (the LLM's raw output is "approximately 1" by prompt contract).
  const outcomes: OutcomeEstimate[] = parsed.probabilities.map((p) => ({ probability: p / sum, confidence }));

  const result: ForecastResult = {
    outcomes,
    rationale: parsed.rationale ?? "",
    sourcesUsed,
  };

  cache.set(market.address, { inputHash, result });
  lastOutcomeStatus = "ok";
  return result;
}
