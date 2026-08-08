/**
 * F2 — LLM token budget, two independent layers:
 *
 *   1. Rolling 24h budget (forecastBudget.dailyTokenBudget) — our own
 *      accounting, a backstop with margin. Groq's real daily figure is
 *      request-count-based (1,000/day), not token-based — see .env.example.
 *
 *   2. Per-minute rate limiter (Phase 5 carry-forward correction) — Groq's
 *      ACTUAL binding limit is 12,000 tokens/MINUTE (confirmed live via the
 *      x-ratelimit-limit-tokens response header, Phase 4 checkpoint).
 *      throttleForRateLimit() spaces out forecast calls to stay under that
 *      with margin, BEFORE a call is made — this is a genuine pacing
 *      mechanism (it can sleep), not just a defer-to-next-pass decision.
 *      llmClient.ts's 429 backoff stays as the fallback for whatever this
 *      doesn't catch (e.g. other processes sharing the same key).
 *
 * Process-lifetime only unless persistence/ has loaded a prior usageLog —
 * see persistence/index.ts, which calls exportUsageLog()/importUsageLog()
 * so a restart doesn't reset either window to zero.
 */
import { forecastBudget } from "../../config/index.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

// Calibrated against a real live Groq forecast call (Phase 4): measured
// usage.total_tokens was 863 for one forecastProbability() call against a
// live competition market (llama-3.3-70b-versatile, this project's actual
// system+user prompt), WITHOUT search evidence in the prompt.
//
// Fix 2 (pre-launch live testing): with SEARCH_API_KEY set, the prompt
// carries an extra evidence block (forecast.ts's MAX_EVIDENCE_ITEMS *
// MAX_SNIPPET_CHARS, plus per-item title/url text) that the 863-token
// baseline didn't account for — this constant is used to PACE calls
// BEFORE they're made (throttleForRateLimit below), so an estimate that's
// too low under-throttles and lets more real calls through per minute than
// Groq's actual cap allows, which is exactly the rate-limit pressure
// observed under back-to-back, search-on load. Raised from 900 to cover
// the worst case (base prompt + max trimmed evidence: 2 items * 200 chars
// + title/url overhead, roughly another ~150 tokens) with margin. This is
// a single shared estimate for both search-on and search-off — slightly
// over-conservative when search is off, which is a safe direction to be
// wrong in for a self-imposed pacing budget.
//
// Lives here (not forecastGovernor.ts) so both it and forecast.ts's
// per-call rate limiter can import one canonical value without a cycle.
export const ESTIMATED_TOKENS_PER_FORECAST = 1100;

// Groq's real per-minute token cap, confirmed live from x-ratelimit-limit-tokens.
const GROQ_TOKENS_PER_MINUTE_LIMIT = 12_000;
const RATE_LIMIT_MARGIN = 0.8; // stay under 80% of the real cap
const RATE_LIMIT_POLL_MS = 1000;

export interface UsageEntry {
  timestampMs: number;
  tokens: number;
}

let usageLog: UsageEntry[] = [];

function pruneOld(now: number): void {
  const cutoff = now - DAY_MS; // the 24h window is the longest we track — pruning to it also bounds the 1-minute window's lookups
  while (usageLog.length > 0 && usageLog[0]!.timestampMs < cutoff) {
    usageLog.shift();
  }
}

export function recordTokenUsage(tokens: number, nowMs: number = Date.now()): void {
  if (tokens <= 0) return;
  usageLog.push({ timestampMs: nowMs, tokens });
  pruneOld(nowMs);
}

export function tokensUsedInWindow(windowMs: number, nowMs: number = Date.now()): number {
  pruneOld(nowMs);
  const cutoff = nowMs - windowMs;
  let sum = 0;
  for (const e of usageLog) if (e.timestampMs >= cutoff) sum += e.tokens;
  return sum;
}

export function tokensUsedInLast24h(nowMs: number = Date.now()): number {
  return tokensUsedInWindow(DAY_MS, nowMs);
}

export function remainingBudget(nowMs: number = Date.now()): number {
  return Math.max(0, forecastBudget.dailyTokenBudget - tokensUsedInLast24h(nowMs));
}

export function hasBudgetFor(estimatedTokens: number, nowMs: number = Date.now()): boolean {
  return remainingBudget(nowMs) >= estimatedTokens;
}

/**
 * Blocks (polling-sleeps) until making a call of `estimatedTokens` would
 * keep the trailing 1-minute window under GROQ_TOKENS_PER_MINUTE_LIMIT *
 * RATE_LIMIT_MARGIN. `nowMs`/`sleep` are injectable for testing without
 * real timers.
 */
export async function throttleForRateLimit(
  estimatedTokens: number,
  nowMs: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<void> {
  const limit = GROQ_TOKENS_PER_MINUTE_LIMIT * RATE_LIMIT_MARGIN;
  while (tokensUsedInWindow(MINUTE_MS, nowMs()) + estimatedTokens > limit) {
    await sleep(RATE_LIMIT_POLL_MS);
  }
}

/** For persistence/index.ts. */
export function exportUsageLog(): UsageEntry[] {
  return [...usageLog];
}

/** For persistence/index.ts, on startup load. Replaces the in-memory log entirely. */
export function importUsageLog(entries: UsageEntry[], nowMs: number = Date.now()): void {
  usageLog = entries.filter((e) => typeof e.timestampMs === "number" && typeof e.tokens === "number");
  pruneOld(nowMs);
}

/** Test-only: clears accumulated usage so tests don't leak state into each other. */
export function resetTokenBudget(): void {
  usageLog = [];
}
