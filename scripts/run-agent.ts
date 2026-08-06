/**
 * Phase 5B — the production entrypoint. This is what deploy/delphi-agent.service
 * runs, and the ONLY script this project's deployment path invokes.
 *
 * Deliberately imports nothing from scripts/paper-run.ts (which contains the
 * synthetic-candidate demo, fenced to PAPER-only at runtime) — that module is
 * not reachable from here at all, at the import-graph level, not just via a
 * runtime isLive() check. See tests/liveEntryIsolation.test.ts, which fails
 * the build if this file (or anything runLoop pulls in) ever references it.
 *
 * AGENT_MODE defaults to "paper" (src/config/index.ts) — this script never
 * overrides that. LIVE only happens if the operator explicitly sets
 * AGENT_MODE=live in the deployed .env — see README.md "Switching to LIVE".
 *
 * Usage: npm run agent   (equivalently: npx tsx scripts/run-agent.ts)
 * Runs forever (no maxTicks) until the process manager stops/restarts it.
 */
import { runLoop } from "../src/loop/finalizedLoop.js";
import { AGENT_MODE, isLive } from "../src/config/index.js";

function log(level: "info" | "warn" | "error", message: string): void {
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`;
  if (level === "error") console.error(line);
  else console.log(line);
}

log("info", `=== delphi-agent starting — AGENT_MODE=${AGENT_MODE} (isLive=${isLive()}) ===`);
if (isLive()) {
  log("warn", "LIVE mode — real on-chain transactions will be sent. Confirm this was intentional (README.md 'Switching to LIVE').");
}

await runLoop({
  onLog: log,
  onTick: (tick) => {
    if (tick.error) {
      log("error", `tick (${tick.triggeredBy}) failed: ${tick.error}`);
      return;
    }
    if (!tick.passResult) return;
    const { decisions, forecastGovernor, activityCounters } = tick.passResult;
    log(
      "info",
      `tick (${tick.triggeredBy}) complete — decisions=${decisions.length} traded=${decisions.filter((d) => d.outcome === "traded").length} ` +
        `forecastGovernor=${JSON.stringify(forecastGovernor)} activity=${JSON.stringify(activityCounters)}`
    );
  },
});
