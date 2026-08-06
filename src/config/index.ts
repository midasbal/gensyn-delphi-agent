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

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
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
  /** Max total TST committed across all open positions. */
  maxTotalExposureTokens: Number(process.env.MAX_TOTAL_EXPOSURE_TOKENS ?? 100),
  /** Gate (a): minimum combined-signal confidence to consider trading at all. */
  minConfidence: Number(process.env.MIN_CONFIDENCE ?? 0.5),
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
};

// --- Activity-floor constants (Phase 3+ loop enforces these deliberately) ---
export const activity = {
  minTradesOverWindow: Number(process.env.MIN_TRADES_OVER_WINDOW ?? 10),
  minDistinctMarkets: Number(process.env.MIN_DISTINCT_MARKETS ?? 5),
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

export { requireEnv };
