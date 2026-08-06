/**
 * Phase 5 checkpoint: runs the FINALIZED loop (loop/finalizedLoop.ts) for a
 * bounded number of ticks against the real live competition markets —
 * proving the cadence + persistence + retry wiring actually works, not just
 * runPaperPass in isolation (already proven since Phase 3/4).
 *
 * Usage: npm run loop-demo -- <maxTicks>  (default 1)
 */
import { runLoop } from "../src/loop/finalizedLoop.js";
import { AGENT_MODE, isLive } from "../src/config/index.js";

const maxTicks = Number(process.argv[2] ?? 1);

console.log(`=== Finalized loop demo — AGENT_MODE=${AGENT_MODE} (isLive=${isLive()}) — maxTicks=${maxTicks} ===\n`);

await runLoop({
  maxTicks,
  cadenceMs: 5000, // short for the demo — production uses loop.cadenceSeconds (default 300s)
  eventPollMs: 2000,
  onLog: (level, message) => console.log(`[${level.toUpperCase()}] ${message}`),
  onTick: async (tick) => {
    console.log(`\n--- tick (triggeredBy=${tick.triggeredBy}) ---`);
    if (tick.error) {
      console.log(`error: ${tick.error}`);
      return;
    }
    if (!tick.passResult) {
      console.log("no pass result");
      return;
    }
    console.log(`decisions: ${tick.passResult.decisions.length}`);
    console.log(`trades this pass: ${tick.passResult.portfolio.trades.length} total (cumulative)`);
    console.log(`forecast governor: ${JSON.stringify(tick.passResult.forecastGovernor)}`);
    console.log(`activity: ${JSON.stringify(tick.passResult.activityCounters)}`);
  },
});

console.log("\n=== loop demo complete ===");
