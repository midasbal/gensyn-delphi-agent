/**
 * Minimal Anthropic Messages API client, gated on ANTHROPIC_API_KEY.
 *
 * NOT independently verified live this session — no ANTHROPIC_API_KEY is
 * provisioned in .env, so structureResolution.ts and forecast.ts have only
 * ever exercised their "unconfigured" degrade path. The request/response
 * handling follows the documented Messages API shape but should be treated
 * as unverified until it runs once with a real key.
 *
 * No SDK dependency added for this — it's a single JSON POST, and pulling in
 * @anthropic-ai/sdk for one endpoint isn't worth the footprint.
 */
import { signals } from "../../config/index.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const FETCH_TIMEOUT_MS = 30_000;

export function isLLMConfigured(): boolean {
  return !!signals.llmApiKey;
}

/** Returns the raw text of the first text content block, or null on any failure — never throws. */
export async function callLLM(system: string, user: string): Promise<string | null> {
  if (!signals.llmApiKey) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": signals.llmApiKey,
        "anthropic-version": API_VERSION,
      },
      body: JSON.stringify({
        model: signals.llmModel,
        max_tokens: 1024,
        system,
        messages: [{ role: "user", content: user }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const textBlock = data.content?.find((b) => b.type === "text");
    return textBlock?.text ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Extracts the first {...} JSON object from LLM output (handles ```json fences). Returns null on failure. */
export function extractJson<T>(text: string): T | null {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1]! : text;
  const braceStart = candidate.indexOf("{");
  const braceEnd = candidate.lastIndexOf("}");
  if (braceStart === -1 || braceEnd === -1 || braceEnd <= braceStart) return null;
  try {
    return JSON.parse(candidate.slice(braceStart, braceEnd + 1)) as T;
  } catch {
    return null;
  }
}
