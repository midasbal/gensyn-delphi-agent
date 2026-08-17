/**
 * Environment + network config + tunable constants.
 *
 * SDK 2.1.0 quirk (verified against the live client): reading on-chain prices
 * (`pricesAndImpliedProbabilities: true`) runs a multicall through
 * `DelphiClient.getSigner()`, so WALLET_PRIVATE_KEY must be present even for a
 * pure read. That means a loaded key is NOT evidence of intent to trade — the
 * only thing that may gate sending a transaction is AGENT_MODE. Every write
 * path in execution/ must check `isLive()` itself; never infer "safe to send a
 * tx" from "a signer is configured".
 */
import "dotenv/config";

export type AgentMode = "paper" | "live";

/** All *_ENABLED flags default to false — every Phase 4 layer is opt-in, nothing changes behavior until explicitly turned on. */
function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw.toLowerCase() === "true" || raw === "1";
}

const rawMode = (process.env.AGENT_MODE ?? "paper").toLowerCase();
if (rawMode !== "paper" && rawMode !== "live") {
  throw new Error(`AGENT_MODE must be "paper" or "live", got: ${JSON.stringify(process.env.AGENT_MODE)}`);
}

/** "paper" unless AGENT_MODE=live is explicitly set. This is the ONLY switch
 *  that may permit an on-chain transaction — see execution/ for the gate. */
export const AGENT_MODE: AgentMode = rawMode;
export const isLive = () => AGENT_MODE === "live";
export const isPaper = () => AGENT_MODE === "paper";

export const network = {
  network: "competition-testnet" as const,
  chainId: Number(process.env.GENSYN_CHAIN_ID ?? 685685),
  rpcUrl: process.env.GENSYN_RPC_URL ?? "https://gensyn-testnet.g.alchemy.com/public",
  collateralSymbol: "TST",
  collateralDecimals: 6,
  shareDecimals: 18,
  /** Unset = the API's currently active competition. */
  competitionId: process.env.DELPHI_COMPETITION_ID || undefined,
};

// --- Risk / sizing constants ---
export const risk = {
  /** Minimum |edge| (your probability - market price) required to act. */
  edgeThreshold: Number(process.env.EDGE_THRESHOLD ?? 0.05),
  /** Default slippage tolerance for quote-then-trade, per the project brief. */
  defaultSlippageBps: Number(process.env.DEFAULT_SLIPPAGE_BPS ?? 200), // 2%
  /** Fraction of full Kelly to size positions at. Conservative by design — q is an estimate with error. */
  kellyFraction: Number(process.env.KELLY_FRACTION ?? 0.25),
  /** Max TST committed to a single market. */
  maxPositionTokens: Number(process.env.MAX_POSITION_TOKENS ?? 10),
  /** Max fraction of live account value (bankroll plus current total cost basis) committed across all open positions at once. Replaces the old flat MAX_TOTAL_EXPOSURE_TOKENS, which never scaled with the account and could saturate permanently after one bet. */
  maxTotalExposureFraction: Number(process.env.MAX_TOTAL_EXPOSURE_FRACTION ?? 0.65),
  /** Max fraction of live account value committed to a single market's entry. Bounds the first (and, per the over-re-entry guard, only) buy into a market. */
  maxPerMarketExposureFraction: Number(process.env.MAX_PER_MARKET_EXPOSURE_FRACTION ?? 0.1),
  /** Gate (a): minimum combined-signal confidence to consider trading at all. */
  minConfidence: Number(process.env.MIN_CONFIDENCE ?? 0.5),
  /**
   * Trade-scored calibration (reports/calibration-report.json) found the
   * model's forecasts underperformed the market prices they traded
   * against, worst on the largest divergences: capital-weighted model
   * Brier 0.274 vs market 0.210 overall, and 0/12 win rate on trades with
   * |edge| > 0.25. Two controls address this:
   *
   * marketShrinkLambda: how far our probability moves toward the quoted
   * price before edge/sizing, 0 to 1. 0 = trust the model fully (the old
   * behavior). 1 = trust the market fully (edge always collapses to 0,
   * never trades). 0.5 (the default) moves our estimate halfway to the
   * market. Applied once, before edge is computed, so both the edge-
   * threshold gate and Kelly sizing see the shrunk value, every position
   * shrinks proportionally along with the edge that sized it. See
   * risk/gates.ts's shrinkTowardMarket().
   */
  marketShrinkLambda: Number(process.env.MARKET_SHRINK_LAMBDA ?? 0.5),
  /**
   * Hard cutoff on the RAW divergence (ourProbability - price, BEFORE
   * shrinking): every trade past this in the calibration data lost, so
   * this refuses to act on it at all rather than merely shrinking it.
   * Checked before marketShrinkLambda is applied, see risk/gates.ts.
   */
  maxRawEdge: Number(process.env.MAX_RAW_EDGE ?? 0.25),
  /** Gate (b): oracle-ambiguity score (0-1, heuristic) above which a candidate is skipped outright. */
  oracleAmbiguitySkipThreshold: Number(process.env.ORACLE_AMBIGUITY_SKIP_THRESHOLD ?? 0.75),
  /** Gate (d): price within this distance of 0 or 1 is an "extreme" — edge requirement widens, size shrinks. */
  extremeZoneMargin: Number(process.env.EXTREME_ZONE_MARGIN ?? 0.05),
  /** Gate (d): multiplier applied to edgeThreshold inside the extreme zone. */
  extremeEdgeMultiplier: Number(process.env.EXTREME_EDGE_MULTIPLIER ?? 3),
  /** Gate (d): multiplier applied to position size inside the extreme zone. */
  extremeSizeMultiplier: Number(process.env.EXTREME_SIZE_MULTIPLIER ?? 0.25),
  /** Below this TST size, a would-be trade is dust — skip instead of sending a near-zero order. */
  dustThresholdTokens: Number(process.env.DUST_THRESHOLD_TOKENS ?? 0.05),
  /** PAPER-mode starting bankroll, in TST. Irrelevant to LIVE (real balance is read from chain). */
  paperStartingBankroll: Number(process.env.PAPER_STARTING_BANKROLL ?? 1000),

  // --- F1: thin-market fill rule (Phase 4) ---
  /** When false (default), gate f keeps its Phase 3 behavior: hard-skip if the
   *  desired size can't clear slippage even at the technical floor. When true,
   *  it steps size down and allows fills below the soft dust floor (but never
   *  below hardMinShares) as long as the edge still clears at the ACTUAL fill
   *  price — see execution/thinMarketFill.ts. */
  thinMarketFillsEnabled: boolEnv("THIN_MARKET_FILLS_ENABLED", false),
  /** Absolute technical floor (share granularity) — never fill below this, no matter what. */
  hardMinShares: Number(process.env.HARD_MIN_SHARES ?? 0.01),
  /** Slippage tolerance as a fraction (0.02 = 2%). Defaults from defaultSlippageBps unless overridden directly. */
  slippageTolerance: Number(process.env.SLIPPAGE_TOLERANCE ?? Number(process.env.DEFAULT_SLIPPAGE_BPS ?? 200) / 10_000),
};

// --- Activity-floor constants (Phase 3+ loop enforces these deliberately) ---
export const activity = {
  minTradesOverWindow: Number(process.env.MIN_TRADES_OVER_WINDOW ?? 10),
  minDistinctMarkets: Number(process.env.MIN_DISTINCT_MARKETS ?? 5),
};

// --- Phase 4 layer flags. Every layer is opt-in (defaults false) and feeds
// the risk gate or the signal combiner — none of them ever trades on its own. ---
export const layers = {
  // Layer A — latency: consensus-driven requeue, no LLM call on this path.
  aEnabled: boolEnv("A_ENABLED", false),
  /** Absolute move in a reference probability (0-1 scale) vs our last-acted value that triggers a requeue. */
  aReferenceMoveThreshold: Number(process.env.A_REFERENCE_MOVE_THRESHOLD ?? 0.05),
  aPollSeconds: Number(process.env.A_POLL_SECONDS ?? 30),

  // Layer B — long-tail routing.
  bEnabled: boolEnv("B_ENABLED", false),

  // Layer C — cross-market coherence.
  cEnabled: boolEnv("C_ENABLED", false),

  // Layer D — opponent modeling (public subgraph data only). A herding call
  // requires BOTH a minimum trade count AND a minimum total notional in the
  // observed window — a handful of dust-sized trades shouldn't count as a
  // crowd (Phase 5 carry-forward correction).
  dEnabled: boolEnv("D_ENABLED", false),
  dMinTrades: Number(process.env.D_MIN_TRADES ?? 5),
  dMinNotional: Number(process.env.D_MIN_NOTIONAL ?? 5), // TST
};

// --- F2: forecast token-budget governor (Phase 4). Protects the free Groq
// tier — set LLM_DAILY_TOKEN_BUDGET below Groq's real cap with margin once
// the real cap is known from response headers (see llmClient.ts). ---
export const forecastBudget = {
  dailyTokenBudget: Number(process.env.LLM_DAILY_TOKEN_BUDGET ?? 80_000),
  /** Re-forecast a market only after this many minutes, even if inputs are unchanged — not every loop pass. */
  forecastStalenessMinutes: Number(process.env.FORECAST_STALENESS_MINUTES ?? 30),

  // --- Conditional search: a cheap no-search forecast runs first; a
  // second, search-augmented call only fires when it could plausibly
  // change a trade decision — see forecast.ts's shouldRunSearchAugmented().
  // Defaults to ON (true) so a fresh checkout is already token-conserving;
  // set false to fall back to the old always-search-if-configured behavior. ---
  conditionalSearchEnabled: boolEnv("CONDITIONAL_SEARCH_ENABLED", true),
  /** Below this confidence, the no-search forecast is treated as too uncertain to trust on its own. */
  forecastSearchConfThreshold: Number(process.env.FORECAST_SEARCH_CONF_THRESHOLD ?? 0.5),
  /** Minimum |no-search forecast probability - market price| for a search-augmented re-forecast to be worth its tokens — reuses risk.edgeThreshold by default, since that's the same bar a trade would need to clear anyway. */
  forecastSearchMinEdge: Number(process.env.FORECAST_SEARCH_MIN_EDGE ?? risk.edgeThreshold),
};

// --- Phase 5: the persistent loop's cadence + retry behavior. ---
export const loop = {
  /** Base interval between full decision passes. */
  cadenceSeconds: Number(process.env.LOOP_CADENCE_SECONDS ?? 300),
  /** Between cadence ticks, Layer A polls this often (reuses layers.aPollSeconds) and can trigger an early pass if a reference/price moves past threshold. */
  maxRetries: Number(process.env.LOOP_MAX_RETRIES ?? 3),
  retryBaseDelayMs: Number(process.env.LOOP_RETRY_BASE_DELAY_MS ?? 2000),
};

// --- Signal source config (Phase 2). Every key here is OPTIONAL — an
// adapter/the LLM must report itself "unconfigured" and degrade to null
// rather than throw when its key is absent. The user provisions these. ---
export type LlmProvider = "groq" | "anthropic" | "openai-compatible";

const rawLlmProvider = (process.env.LLM_PROVIDER ?? "groq").toLowerCase();
if (rawLlmProvider !== "groq" && rawLlmProvider !== "anthropic" && rawLlmProvider !== "openai-compatible") {
  throw new Error(`LLM_PROVIDER must be "groq", "anthropic", or "openai-compatible", got: ${JSON.stringify(process.env.LLM_PROVIDER)}`);
}
const llmProvider = rawLlmProvider as LlmProvider;

// Per-provider default model — only used if LLM_MODEL is unset. Groq's
// default was confirmed live against console.groq.com/docs/models (not
// assumed from training data) — see llmClient.ts's header comment.
const DEFAULT_LLM_MODEL: Record<LlmProvider, string> = {
  groq: "llama-3.3-70b-versatile",
  anthropic: "claude-sonnet-5",
  "openai-compatible": "gpt-4o-mini",
};

export const signals = {
  oddsApiKey: process.env.ODDS_API_KEY || undefined,
  llmProvider,
  groqApiKey: process.env.GROQ_API_KEY || undefined,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || undefined,
  openaiCompatibleApiKey: process.env.OPENAI_COMPATIBLE_API_KEY || undefined,
  openaiCompatibleBaseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL || undefined,
  llmModel: process.env.LLM_MODEL || DEFAULT_LLM_MODEL[llmProvider],
  searchApiKey: process.env.SEARCH_API_KEY || undefined, // e.g. Tavily — for forecasting/ live news retrieval
  /** Caps how much a forecast-ONLY signal (no consensus backing at all) can
   *  influence sizing, regardless of the model's self-reported confidence —
   *  see signals/combine.ts. Protects against an overconfident/uncalibrated
   *  model dominating a trade before we have real resolution data to check
   *  its calibration against (that's Phase 4 Layer F's job). */
  forecastOnlyMaxWeight: Number(process.env.FORECAST_ONLY_MAX_WEIGHT ?? 0.5),
};
