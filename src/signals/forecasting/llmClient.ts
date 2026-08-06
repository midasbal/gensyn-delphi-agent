/**
 * Provider-agnostic LLM client for structureResolution.ts / forecast.ts.
 * Public interface is unchanged from the single-provider version:
 * `isLLMConfigured()` / `callLLM(system, user) -> Promise<string | null>`.
 * Callers never see which provider is active.
 *
 * Default provider: Groq (free tier) — LLM_PROVIDER=groq (or unset).
 *   - Groq exposes an OpenAI-compatible chat-completions API at
 *     https://api.groq.com/openai/v1, key from GROQ_API_KEY.
 *   - Default model: `llama-3.3-70b-versatile`. Confirmed LIVE against
 *     console.groq.com/docs/models on 2026-08-06 (not assumed from training
 *     data, per instruction) — listed there under "Production Models"
 *     ("intended for use in your production environments"), 131,072-token
 *     context, no deprecation warning. Note: a web search on the same day
 *     surfaced third-party aggregator pages (not Groq's own docs) claiming
 *     this model is deprecated in favor of `openai/gpt-oss-120b` — the
 *     primary source (Groq's docs page, fetched twice) directly contradicts
 *     that, so this uses the primary source. If Groq actually deprecates it
 *     later, override with LLM_MODEL=openai/gpt-oss-120b in .env; no code
 *     change needed.
 *   - Free-tier rate limits confirmed from console.groq.com/docs/rate-limits
 *     for this model: 30 requests/min, 1,000 requests/day, 12,000
 *     tokens/min, 100,000 tokens/day. That's tight enough that backoff and
 *     forecast caching (see forecast.ts) aren't optional — see below.
 *
 * Alternate providers:
 *   - LLM_PROVIDER=anthropic — Messages API, key from ANTHROPIC_API_KEY.
 *   - LLM_PROVIDER=openai-compatible — any OpenAI-chat-completions-shaped
 *     endpoint (local vLLM/Ollama, another hosted provider), base URL from
 *     OPENAI_COMPATIBLE_BASE_URL, key from OPENAI_COMPATIBLE_API_KEY.
 *
 * Whichever provider is active, a missing key degrades to
 * isLLMConfigured()===false and callLLM()===null — never a crash. A
 * persistent 429 (rate-limited even after backoff) also returns null, which
 * the caller (forecast.ts) treats as "defer this market to the next pass",
 * not a hard failure — see getLastCallStatus() for observability without
 * changing callLLM's return type.
 */
import { signals } from "../../config/index.js";

const FETCH_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;

export type LLMCallStatus = "ok" | "unconfigured" | "rate_limited" | "error";
let lastCallStatus: LLMCallStatus | null = null;
let lastRateLimitHeaders: Record<string, string> | null = null;
let lastTokensUsed: number | null = null;

/** For reporting/observability only — does not change callLLM's contract. */
export function getLastLLMCallStatus(): LLMCallStatus | null {
  return lastCallStatus;
}

/** Every x-ratelimit-* response header from the most recent call — this is how F2 discovers the REAL provider limits rather than assuming them. Null until at least one call has been made. */
export function getLastRateLimitHeaders(): Record<string, string> | null {
  return lastRateLimitHeaders;
}

/** Total tokens (prompt+completion) reported by the provider's `usage` field for the most recent successful call, for F2's token-budget tracking. Null if unavailable (unconfigured/errored/provider omitted usage). */
export function getLastTokensUsed(): number | null {
  return lastTokensUsed;
}

function captureRateLimitHeaders(res: Response): void {
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    if (key.toLowerCase().startsWith("x-ratelimit-")) headers[key] = value;
  });
  lastRateLimitHeaders = Object.keys(headers).length > 0 ? headers : lastRateLimitHeaders;
}

export function isLLMConfigured(): boolean {
  switch (signals.llmProvider) {
    case "groq":
      return !!signals.groqApiKey;
    case "anthropic":
      return !!signals.anthropicApiKey;
    case "openai-compatible":
      return !!signals.openaiCompatibleApiKey && !!signals.openaiCompatibleBaseUrl;
  }
}

async function fetchWithBackoff(url: string, init: RequestInit): Promise<Response | null> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: controller.signal });
    } catch {
      clearTimeout(timeout);
      return null;
    }
    clearTimeout(timeout);

    if (res.status !== 429) return res;
    if (attempt === MAX_RETRIES) return res; // give up — caller sees the 429 and treats it as deferred, not a crash

    const retryAfterHeader = res.headers.get("retry-after");
    const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : NaN;
    const backoffMs = Number.isFinite(retryAfterSec) ? retryAfterSec * 1000 : Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }
  return null;
}

async function callAnthropic(system: string, user: string, temperature?: number): Promise<string | null> {
  const res = await fetchWithBackoff("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": signals.anthropicApiKey!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: signals.llmModel,
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: user }],
      ...(temperature !== undefined ? { temperature } : {}),
    }),
  });
  if (!res) {
    lastCallStatus = "error";
    return null;
  }
  captureRateLimitHeaders(res);
  if (res.status === 429) {
    lastCallStatus = "rate_limited";
    return null;
  }
  if (!res.ok) {
    lastCallStatus = "error";
    return null;
  }
  const data = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const textBlock = data.content?.find((b) => b.type === "text");
  lastTokensUsed = data.usage ? (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0) : null;
  lastCallStatus = "ok";
  return textBlock?.text ?? null;
}

/** Shared by Groq and the generic openai-compatible provider — both speak the OpenAI chat-completions shape. */
async function callOpenAiCompatible(baseUrl: string, apiKey: string, system: string, user: string, temperature?: number): Promise<string | null> {
  const res = await fetchWithBackoff(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: signals.llmModel,
      max_tokens: 1024,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      ...(temperature !== undefined ? { temperature } : {}),
    }),
  });
  if (!res) {
    lastCallStatus = "error";
    return null;
  }
  captureRateLimitHeaders(res);
  if (res.status === 429) {
    lastCallStatus = "rate_limited";
    return null;
  }
  if (!res.ok) {
    lastCallStatus = "error";
    return null;
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { total_tokens?: number };
  };
  lastTokensUsed = data.usage?.total_tokens ?? null;
  lastCallStatus = "ok";
  return data.choices?.[0]?.message?.content ?? null;
}

export async function callLLM(system: string, user: string, opts?: { temperature?: number }): Promise<string | null> {
  if (!isLLMConfigured()) {
    lastCallStatus = "unconfigured";
    return null;
  }

  const temperature = opts?.temperature;
  switch (signals.llmProvider) {
    case "groq":
      return callOpenAiCompatible("https://api.groq.com/openai/v1", signals.groqApiKey!, system, user, temperature);
    case "anthropic":
      return callAnthropic(system, user, temperature);
    case "openai-compatible":
      return callOpenAiCompatible(signals.openaiCompatibleBaseUrl!, signals.openaiCompatibleApiKey!, system, user, temperature);
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
