/**
 * LLM-based forecasting for markets with no confident (high-quality)
 * consensus reference. Base-rate-first: the prompt explicitly asks the model
 * to anchor on a base rate before adjusting for specifics, and to use
 * retrieved search snippets (if any) over its own training knowledge for
 * anything time-sensitive.
 *
 * Returns null — not a fabricated guess — when the LLM is unconfigured or
 * the call/parse fails. combine.ts must never receive a probability that
 * didn't come from an actual model call.
 *
 * Asks for a probability per outcome (not just outcomes[0]) so this works
 * for N-outcome markets, not just binary — see signals/types.ts.
 */
import type { NormalizedMarket } from "../../markets/types.js";
import type { StructuredResolution, ForecastResult } from "./types.js";
import type { OutcomeEstimate } from "../types.js";
import { isLLMConfigured, callLLM, extractJson } from "./llmClient.js";
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

export async function forecastProbability(
  market: NormalizedMarket,
  structured: StructuredResolution
): Promise<ForecastResult | null> {
  if (!isLLMConfigured()) return null;

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
  if (!text) return null;

  const parsed = extractJson<{ probabilities?: number[]; confidence?: number; rationale?: string }>(text);
  if (!parsed || !Array.isArray(parsed.probabilities) || typeof parsed.confidence !== "number") return null;
  if (parsed.probabilities.length !== market.outcomeCount) return null;
  if (parsed.probabilities.some((p) => typeof p !== "number" || p < 0 || p > 1 || Number.isNaN(p))) return null;

  const sum = parsed.probabilities.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > SUM_TOLERANCE) return null;

  const confidence = Math.min(1, Math.max(0, parsed.confidence));
  // Renormalize to exactly 1 (the LLM's raw output is "approximately 1" by prompt contract).
  const outcomes: OutcomeEstimate[] = parsed.probabilities.map((p) => ({ probability: p / sum, confidence }));

  return {
    outcomes,
    rationale: parsed.rationale ?? "",
    sourcesUsed,
  };
}
