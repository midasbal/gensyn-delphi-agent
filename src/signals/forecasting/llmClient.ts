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

// Fix 2 (pre-launch live testing on the real market set): with
// SEARCH_API_KEY set, forecast.ts's evidence-augmented prompt is heavier
// than the plain (no-search) prompt this project was originally calibrated
// against — under back-to-back, unpaced load (many markets in a row, no
// gap between calls) that pushed several later calls into "call/parse
// failed" territory. A slow-but-otherwise-healthy response (higher
// queue_time/generation time under load, not a 429) is NEVER retried by
// fetchWithBackoff below — a single hard-timeout kills the whole call with
// zero retry — so 30s was too tight a margin for that case. Raised to 45s
// to absorb realistic latency variance under load; this does NOT change
// the persistent-429 worst case (bounded by MAX_RETRIES/backoff below, not
// this constant) — see README.md's watchdog section for the updated
// worst-case-pass estimate this timeout feeds into.
const FETCH_TIMEOUT_MS = 45_000;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;

export type LLMCallStatus = "ok" | "unconfigured" | "rate_limited" | "error";
let lastCallStatus: LLMCallStatus | null = null;
let lastTokensUsed: number | null = null;

/** For reporting/observability only — does not change callLLM's contract. */
export function getLastLLMCallStatus(): LLMCallStatus | null {
  return lastCallStatus;
}

/** Total tokens (prompt+completion) reported by the provider's `usage` field for the most recent successful call, for F2's token-budget tracking. Null if unavailable (unconfigured/errored/provider omitted usage). */
export function getLastTokensUsed(): number | null {
  return lastTokensUsed;
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

/**
 * Observed live (Phase 5 checkpoint): AbortController.abort() does not
 * reliably unblock an in-flight fetch() in this environment — a stuck
 * request can hang well past FETCH_TIMEOUT_MS with the abort signal fired
 * and ignored. Racing a promise against an independent timer is the
 * backstop: it can't cancel the underlying request (that's still
 * AbortController's job, kept in fetchWithBackoff below as a best-effort),
 * but it guarantees the caller never blocks past `ms` regardless of what
 * the raced promise does. Used both for the initial fetch() and — same
 * backstop, different hang — for reading the response body afterward
 * (headers can arrive while the body stream stalls).
 *
 * Fix 2 hardening: always clears its own timer via `finally`, regardless
 * of which side of the race settles first — the original version's timer
 * leaked whenever the real operation won (harmless most of the time, but
 * it meant every fast-resolving call still left a dangling timer alive
 * for the full `ms`, which became a real problem once FETCH_TIMEOUT_MS was
 * raised to 45s as part of this same fix: it was tripling this project's
 * test-suite wall-clock time).
 */
function withHardTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("fetch-hard-timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function fetchWithBackoff(url: string, init: RequestInit): Promise<Response | null> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await withHardTimeout(fetch(url, { ...init, signal: controller.signal }), FETCH_TIMEOUT_MS);
    } catch {
      clearTimeout(timeout);
      return null;
    }
    clearTimeout(timeout);

    if (res.status !== 429) return res;
    if (attempt === MAX_RETRIES) return res; // give up — caller sees the 429 and treats it as deferred, not a crash

    // Phase 5 checkpoint finding: Groq's retry-after header can be huge
    // (observed 200-1400+ seconds under real rate-limit pressure) — using it
    // uncapped stalled the whole pipeline for minutes. Always cap at
    // MAX_BACKOFF_MS: giving up sooner and deferring this market to the next
    // pass is strictly better than blocking the loop on one server-suggested
    // wait, especially since a persistent 429 is already treated as
    // "deferred, not a crash" once retries are exhausted.
    const retryAfterHeader = res.headers.get("retry-after");
    const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : NaN;
    const backoffMs = Number.isFinite(retryAfterSec) ? Math.min(MAX_BACKOFF_MS, retryAfterSec * 1000) : Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
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
  if (res.status === 429) {
    lastCallStatus = "rate_limited";
    return null;
  }
  if (!res.ok) {
    lastCallStatus = "error";
    return null;
  }
  let data: { content?: Array<{ type: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
  try {
    data = await withHardTimeout(res.json(), FETCH_TIMEOUT_MS);
  } catch {
    lastCallStatus = "error";
    return null;
  }
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
  if (res.status === 429) {
    lastCallStatus = "rate_limited";
    return null;
  }
  if (!res.ok) {
    lastCallStatus = "error";
    return null;
  }
  let data: { choices?: Array<{ message?: { content?: string } }>; usage?: { total_tokens?: number } };
  try {
    data = await withHardTimeout(res.json(), FETCH_TIMEOUT_MS);
  } catch {
    lastCallStatus = "error";
    return null;
  }
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
