/**
 * Durable local store: what a restart must NOT lose (per the Phase 5 brief)
 * — Layer A baselines, the resolution-structuring cache, per-market
 * last-forecast timestamps (bundled with the full forecast cache — see
 * forecast.ts's exportForecastCache doc), the token-usage window (both the
 * 24h and 1-minute windows live in the same log), portfolio/positions, and
 * Layer E's (stub) resolution log.
 *
 * Load on startup (loadPersistedState), persist on change (persistState —
 * called by loop/ after each pass; see loop/finalizedLoop.ts). A JSON file
 * under state/, gitignored, written atomically (persistence/store.ts).
 */
import { readJsonFile, writeJsonFileAtomic } from "./store.js";
import { exportLastActed, importLastActed, type LastActed } from "../layers/latency/index.js";
import { exportStructureCache, importStructureCache } from "../signals/forecasting/structureResolution.js";
import { exportForecastCache, importForecastCache, type CacheEntry } from "../signals/forecasting/forecast.js";
import { exportUsageLog, importUsageLog, type UsageEntry } from "../signals/forecasting/tokenBudget.js";
import { exportResolutionLog, importResolutionLog, type ResolutionLogEntry } from "../layers/oracle/index.js";
import { PaperPortfolio, type PersistedPortfolio } from "../portfolio/paperPortfolio.js";
import { risk } from "../config/index.js";
import type { StructuredResolution } from "../signals/forecasting/types.js";

export const DEFAULT_STATE_PATH = "state/agent-state.json";
const STATE_VERSION = 1;

export interface PersistedState {
  version: number;
  savedAtMs: number;
  layerALastActed: Record<string, LastActed>;
  structureCache: Record<string, StructuredResolution>;
  forecastCache: Record<string, CacheEntry>;
  tokenUsageLog: UsageEntry[];
  portfolio: PersistedPortfolio;
  oracleResolutionLog: ResolutionLogEntry[];
}

/**
 * Loads state/agent-state.json (if present) and imports it into every
 * module's in-memory cache, returning the restored portfolio. If no state
 * file exists yet (first run), imports nothing and returns a fresh
 * portfolio at the configured starting bankroll — this is the correct,
 * expected first-run state, not an error.
 */
export async function loadPersistedState(path: string = DEFAULT_STATE_PATH): Promise<PaperPortfolio> {
  const data = await readJsonFile<PersistedState>(path);
  if (!data) {
    return new PaperPortfolio(risk.paperStartingBankroll);
  }

  importLastActed(data.layerALastActed ?? {});
  importStructureCache(data.structureCache ?? {});
  importForecastCache(data.forecastCache ?? {});
  importUsageLog(data.tokenUsageLog ?? []);
  importResolutionLog(data.oracleResolutionLog ?? []);

  return data.portfolio ? PaperPortfolio.fromPersisted(data.portfolio) : new PaperPortfolio(risk.paperStartingBankroll);
}

/** Gathers every module's current in-memory state and writes it atomically. Called by loop/ after each pass (and anywhere else a durable checkpoint is worth taking, e.g. right after a trade). */
export async function persistState(portfolio: PaperPortfolio, path: string = DEFAULT_STATE_PATH): Promise<void> {
  const state: PersistedState = {
    version: STATE_VERSION,
    savedAtMs: Date.now(),
    layerALastActed: exportLastActed(),
    structureCache: exportStructureCache(),
    forecastCache: exportForecastCache(),
    tokenUsageLog: exportUsageLog(),
    portfolio: portfolio.exportState(),
    oracleResolutionLog: exportResolutionLog(),
  };
  await writeJsonFileAtomic(path, state);
}
