/**
 * Phase 5 checkpoint: proves persistence survives a REAL restart, not just
 * an in-process cache clear. Run as two SEPARATE `npx tsx` process
 * invocations against the same state file — each is a genuinely fresh
 * Node process with empty in-memory state, so the "read" phase can only
 * see the "write" phase's data via the actual on-disk state/agent-state.json.
 *
 * Usage:
 *   rm -f state/agent-state.json
 *   npx tsx scripts/demo-persistence-restart.ts write
 *   npx tsx scripts/demo-persistence-restart.ts read
 */
import { loadPersistedState, persistState } from "../src/persistence/index.js";
import { recordActedReference, getLastActed } from "../src/layers/latency/index.js";
import { recordTokenUsage, tokensUsedInLast24h } from "../src/signals/forecasting/tokenBudget.js";
import { recordResolution, getResolutionLog } from "../src/layers/oracle/index.js";

const phase = process.argv[2];

if (phase === "write") {
  const portfolio = await loadPersistedState();
  console.log(`[WRITE] loaded state — bankroll=${portfolio.bankroll} (fresh process, expect nothing prior)`);

  recordActedReference("0xDEMO000000000000000000000000000000000001", 0.42, 0.5);
  recordTokenUsage(1234);
  recordResolution({
    marketAddress: "0xDEMO000000000000000000000000000000000001",
    question: "Demo: will persistence survive a restart?",
    structuredResolution: {
      subject: "persistence restart demo",
      condition: "state file round-trips across two separate processes",
      comparatorOrThreshold: null,
      sourceOfTruth: "this script",
      resolutionTime: null,
      structuredByLLM: false,
    },
    predictedProbability: 0.99,
    winningOutcomeIdx: 0,
    resolvedAt: new Date().toISOString(),
    oracleFailed: false,
  });
  portfolio.recordBuy({
    timestamp: new Date().toISOString(),
    marketAddress: "0xDEMO000000000000000000000000000000000001",
    outcomeIdx: 0,
    question: "Demo: will persistence survive a restart?",
    shares: 3.5,
    tokensIn: 1.75,
    effectivePrice: 0.5,
    slippagePct: 0,
    quotedPrice: 0.5,
    ourProbability: 0.99,
    edge: 0.49,
  });

  await persistState(portfolio);
  console.log(`[WRITE] persisted: bankroll=${portfolio.bankroll}, trades=${portfolio.trades.length}, tokens24h=${tokensUsedInLast24h()}`);
  console.log("[WRITE] done. Now run: npx tsx scripts/demo-persistence-restart.ts read");
} else if (phase === "read") {
  const portfolio = await loadPersistedState();
  console.log(`[READ, simulated restart — fresh process] bankroll=${portfolio.bankroll}`);
  console.log(`[READ] trades restored: ${portfolio.trades.length} — ${JSON.stringify(portfolio.trades[0])}`);
  console.log(`[READ] Layer A baseline restored: ${JSON.stringify(getLastActed("0xDEMO000000000000000000000000000000000001"))}`);
  console.log(`[READ] token usage window restored: ${tokensUsedInLast24h()} tokens`);
  console.log(`[READ] Layer E resolution log restored: ${getResolutionLog().length} entr(y/ies)`);
} else {
  console.error('Usage: npx tsx scripts/demo-persistence-restart.ts <write|read>');
  process.exit(1);
}
