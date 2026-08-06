/**
 * Structures a market's resolution into {subject, condition,
 * comparatorOrThreshold, sourceOfTruth, resolutionTime} via an LLM — per
 * Phase 2 instructions, this is deliberately NOT a regex parser. It consumes
 * Phase 1's ParsedResolution as raw input/context (question, criteria,
 * timing) but the decomposition itself is the LLM's job.
 *
 * Degrades gracefully when no LLM is configured: builds a StructuredResolution
 * directly from the Phase 1 fields (not a new regex pass) with
 * structuredByLLM: false, so downstream consumers can see the provenance and
 * discount confidence accordingly rather than trusting it as if an LLM had
 * reasoned about it.
 */
import type { NormalizedMarket } from "../../markets/types.js";
import type { StructuredResolution } from "./types.js";
import { isLLMConfigured, callLLM, extractJson } from "./llmClient.js";

const SYSTEM_PROMPT = `You decompose prediction-market resolution questions into structured fields.
Given a market question, its outcomes, and (if present) a machine-extracted timing phrase, respond with ONLY a JSON object:
{
  "subject": "the entity/event the question is about",
  "condition": "what must be true for the named/first outcome to resolve YES",
  "comparatorOrThreshold": "the specific number/threshold/comparator if any, else null",
  "sourceOfTruth": "the most likely authoritative source that would be used to settle this, if inferable, else null"
}
Do not include any text outside the JSON object.`;

function degradedFallback(market: NormalizedMarket): StructuredResolution {
  return {
    subject: market.resolution.criteria,
    condition: "",
    comparatorOrThreshold: null,
    sourceOfTruth: null,
    resolutionTime: market.resolvesAt ? market.resolvesAt.toISOString() : null,
    structuredByLLM: false,
  };
}

export async function structureResolution(market: NormalizedMarket): Promise<StructuredResolution> {
  if (!isLLMConfigured()) {
    return degradedFallback(market);
  }

  const userPrompt = JSON.stringify({
    question: market.question,
    outcomes: market.outcomes,
    timingPhrase: market.resolution.timingPhrase,
    resolvesAt: market.resolvesAt?.toISOString() ?? null,
  });

  const text = await callLLM(SYSTEM_PROMPT, userPrompt);
  if (!text) return degradedFallback(market);

  const parsed = extractJson<{
    subject?: string;
    condition?: string;
    comparatorOrThreshold?: string | null;
    sourceOfTruth?: string | null;
  }>(text);
  if (!parsed || typeof parsed.subject !== "string" || typeof parsed.condition !== "string") {
    return degradedFallback(market);
  }

  return {
    subject: parsed.subject,
    condition: parsed.condition,
    comparatorOrThreshold: parsed.comparatorOrThreshold ?? null,
    sourceOfTruth: parsed.sourceOfTruth ?? null,
    resolutionTime: market.resolvesAt ? market.resolvesAt.toISOString() : null,
    structuredByLLM: true,
  };
}
