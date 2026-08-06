/**
 * F2 — rolling 24h LLM token budget. Independent of (and a backstop for)
 * the provider's own rate limits — llmClient.ts's 429 backoff+defer already
 * handles the provider telling us to slow down; this tracks OUR OWN spend
 * against forecastBudget.dailyTokenBudget, which is set BELOW the real
 * provider cap with margin (see .env.example / the Phase 4 checkpoint
 * report for the real Groq limits discovered from response headers).
 *
 * Process-lifetime only, same caveat as every other in-memory tracker in
 * this codebase (layers/latency's lastActed, layers/oracle's
 * resolutionLog) — Phase 5's persistent process is what makes a 24h window
 * meaningful across restarts; a fresh process starts with zero usage, which
 * is the safe default (under-counts spend, never over-counts).
 */
import { forecastBudget } from "../../config/index.js";

const WINDOW_MS = 24 * 60 * 60 * 1000;

interface UsageEntry {
  timestampMs: number;
  tokens: number;
}

const usageLog: UsageEntry[] = [];

function pruneOld(now: number): void {
  const cutoff = now - WINDOW_MS;
  while (usageLog.length > 0 && usageLog[0]!.timestampMs < cutoff) {
    usageLog.shift();
  }
}

export function recordTokenUsage(tokens: number, nowMs: number = Date.now()): void {
  if (tokens <= 0) return;
  usageLog.push({ timestampMs: nowMs, tokens });
  pruneOld(nowMs);
}

export function tokensUsedInLast24h(nowMs: number = Date.now()): number {
  pruneOld(nowMs);
  return usageLog.reduce((sum, e) => sum + e.tokens, 0);
}

export function remainingBudget(nowMs: number = Date.now()): number {
  return Math.max(0, forecastBudget.dailyTokenBudget - tokensUsedInLast24h(nowMs));
}

export function hasBudgetFor(estimatedTokens: number, nowMs: number = Date.now()): boolean {
  return remainingBudget(nowMs) >= estimatedTokens;
}

/** Test-only: clears accumulated usage so tests don't leak state into each other. */
export function resetTokenBudget(): void {
  usageLog.length = 0;
}
