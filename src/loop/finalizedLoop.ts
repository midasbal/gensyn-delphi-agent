/**
 * Phase 5 — the persistent loop: base cadence PLUS event-driven wakeups.
 *
 * Between full decision passes (runPaperPass, unchanged from Phase 4), this
 * polls Layer A's cheap, LLM-free move-check (layers/latency's pollOnce) on
 * a short interval (layers.aPollSeconds). If any open market has moved past
 * threshold since our last full pass, the loop wakes up EARLY and runs a
 * full pass immediately instead of waiting out the rest of the base cadence
 * (loop.cadenceSeconds) — that's the whole point of Layer A. If nothing
 * moves, it just waits for the base cadence like normal.
 *
 * "Respecting F2 pacing": Layer A's own poll is consensus-only (no LLM
 * call, see layers/latency's header), so polling frequently costs nothing
 * against the token budget. What DOES cost tokens is each full pass's
 * forecasting step, and F2 (forecastGovernor.ts) already governs that
 * per-pass regardless of how the pass was triggered — an event-driven early
 * pass goes through the exact same governed forecasting as a cadence-timed
 * one. The only loop-level safeguard added here is a cooldown
 * (MIN_EVENT_WAKEUP_INTERVAL_MS) so a reference jittering right at the
 * threshold can't trigger back-to-back passes.
 *
 * Transient RPC/API errors and listMarkets()==0 are handled HERE, not in
 * sdk/client.ts (which stays a thin pass-through, per the project's
 * ongoing architecture rule) — withRetry wraps each full pass with
 * exponential backoff; if a pass still fails after retries, the loop logs
 * it and waits for the next cadence tick rather than crashing the process
 * (an always-on agent must survive a bad RPC minute). Zero open markets is
 * NOT an error (fetchOpenMarkets already returns [] gracefully, per Phase 0)
 * — the loop just runs an empty, valid pass and waits for the next tick.
 */
import { runPaperPass, type PaperPassResult } from "./paperLoop.js";
import { fetchOpenMarkets } from "../markets/fetch.js";
import { pollOnce } from "../layers/latency/index.js";
import { loop as loopConfig, layers } from "../config/index.js";
import { loadPersistedState, persistState } from "../persistence/index.js";
import { writeHeartbeat } from "./heartbeat.js";
import type { PaperPortfolio } from "../portfolio/paperPortfolio.js";

const MIN_EVENT_WAKEUP_INTERVAL_MS = 10_000; // cooldown against threshold jitter

export type SleepFn = (ms: number) => Promise<void>;
const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxRetries: number; baseDelayMs: number; sleep?: SleepFn; onRetry?: (attempt: number, err: unknown) => void }
): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === opts.maxRetries) break;
      opts.onRetry?.(attempt + 1, err);
      await sleep(opts.baseDelayMs * 2 ** attempt);
    }
  }
  throw lastErr;
}

export interface LoopTickResult {
  triggeredBy: "cadence" | "event" | "initial";
  passResult: PaperPassResult | null;
  error: string | null;
}

export interface LoopOptions {
  statePath?: string;
  cadenceMs?: number;
  eventPollMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  /** Bounds the loop for tests/demos — undefined runs forever. */
  maxTicks?: number;
  sleep?: SleepFn;
  onTick?: (tick: LoopTickResult) => void | Promise<void>;
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
}

/** One full, retried pass: fetch, decide, persist. Never throws past withRetry's budget — the caller logs and moves on. */
async function runPassWithRetry(portfolio: PaperPortfolio, statePath: string, opts: Required<Pick<LoopOptions, "maxRetries" | "retryBaseDelayMs">> & { sleep: SleepFn; onLog: LoopOptions["onLog"] }): Promise<PaperPassResult> {
  const result = await withRetry(() => runPaperPass(portfolio), {
    maxRetries: opts.maxRetries,
    baseDelayMs: opts.retryBaseDelayMs,
    sleep: opts.sleep,
    onRetry: (attempt, err) => opts.onLog?.("warn", `pass failed (attempt ${attempt}/${opts.maxRetries}): ${err instanceof Error ? err.message : String(err)} — retrying`),
  });
  await persistState(portfolio, statePath);
  return result;
}

/**
 * Waits for either the base cadence to elapse or Layer A to detect a move,
 * whichever comes first. Polls in eventPollMs increments so it can react
 * quickly; each poll is a cheap, LLM-free consensus/price check.
 */
async function waitForCadenceOrEvent(cadenceMs: number, eventPollMs: number, sleep: SleepFn, onLog: LoopOptions["onLog"]): Promise<"cadence" | "event"> {
  if (!layers.aEnabled || eventPollMs >= cadenceMs) {
    await sleep(cadenceMs);
    return "cadence";
  }

  let elapsed = 0;
  let sinceLastEventCheck = 0;
  while (elapsed < cadenceMs) {
    const step = Math.min(eventPollMs, cadenceMs - elapsed);
    await sleep(step);
    elapsed += step;
    sinceLastEventCheck += step;
    if (sinceLastEventCheck < MIN_EVENT_WAKEUP_INTERVAL_MS) continue;
    sinceLastEventCheck = 0;

    try {
      const markets = await fetchOpenMarkets({ limit: 50 });
      const pollResults = await pollOnce(markets);
      if (pollResults.some((r) => r.move.moved)) {
        onLog?.("info", `Layer A detected a move — waking early (${pollResults.filter((r) => r.move.moved).length} market(s) moved)`);
        return "event";
      }
    } catch (err) {
      onLog?.("warn", `Layer A poll failed (non-fatal, continuing on cadence): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return "cadence";
}

/** Runs the persistent loop. Resolves only if maxTicks is set and reached; otherwise runs forever (or until the process is killed — pm2/systemd's job, see Phase 5B deployment). */
export async function runLoop(options: LoopOptions = {}): Promise<void> {
  const statePath = options.statePath ?? "state/agent-state.json";
  const cadenceMs = options.cadenceMs ?? loopConfig.cadenceSeconds * 1000;
  const eventPollMs = options.eventPollMs ?? layers.aPollSeconds * 1000;
  const maxRetries = options.maxRetries ?? loopConfig.maxRetries;
  const retryBaseDelayMs = options.retryBaseDelayMs ?? loopConfig.retryBaseDelayMs;
  const sleep = options.sleep ?? defaultSleep;
  const onLog = options.onLog ?? (() => {});

  const portfolio = await loadPersistedState(statePath);
  onLog("info", `loaded persisted state from ${statePath} (bankroll=${portfolio.bankroll.toFixed(4)}, ${portfolio.positions.size} open position(s))`);

  let ticks = 0;
  let triggeredBy: LoopTickResult["triggeredBy"] = "initial";

  while (options.maxTicks === undefined || ticks < options.maxTicks) {
    await writeHeartbeat(`tick-start:${triggeredBy}`).catch(() => {});
    let passResult: PaperPassResult | null = null;
    let error: string | null = null;
    try {
      passResult = await runPassWithRetry(portfolio, statePath, { maxRetries, retryBaseDelayMs, sleep, onLog });
      if (passResult.decisions.length === 0) {
        onLog("info", "pass completed with 0 open markets — valid state, not an error, waiting for next tick");
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      onLog("error", `pass failed after ${maxRetries} retries: ${error} — waiting for next tick`);
    }
    await writeHeartbeat(`tick-end:${triggeredBy}`).catch(() => {});

    await options.onTick?.({ triggeredBy, passResult, error });
    ticks++;
    if (options.maxTicks !== undefined && ticks >= options.maxTicks) break;

    triggeredBy = await waitForCadenceOrEvent(cadenceMs, eventPollMs, sleep, onLog);
  }
}
