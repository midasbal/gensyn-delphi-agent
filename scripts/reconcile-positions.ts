/**
 * ONE-TIME MANUAL STATE RECONCILIATION. This is NOT run automatically by
 * the agent (nothing in loop/ or persistence/ imports this file) and must
 * never be wired into startup. Run it yourself, with the systemd service
 * STOPPED, after verifying on-chain which positions are real.
 *
 * Background: state/agent-state.json's portfolio.positions can contain
 * PAPER GHOST positions recorded before the agent was flipped from PAPER
 * to LIVE. PAPER and LIVE share the same in-memory bookkeeping
 * (PaperPortfolio.recordBuy runs either way, only the on-chain call in
 * execution/paperTrade.ts is mode-gated by isLive()), so a position
 * recorded before the live flip has no matching on-chain buy: it is a
 * ghost. The over-re-entry guard in loop/paperLoop.ts still fences that
 * market off from real trading because it cannot tell a ghost from a real
 * position, nothing in the state file distinguishes them. That distinction
 * has to come from you (checked on-chain), which is exactly what
 * REAL_POSITIONS below encodes.
 *
 * What this script does:
 *   1. Reads the current state file (does not touch it yet).
 *   2. Keeps EXACTLY the positions named in REAL_POSITIONS below, taking
 *      shares/outcomeIdx/outcomeLabel from the CURRENT state (never
 *      invented, aborts if a listed address is not found in the current
 *      positions) and overwriting costBasis with the value you supply.
 *   3. Drops every other position.
 *   4. Recomputes bankroll as startingBankroll minus the sum of the kept
 *      positions' new cost bases. See the derivation note below.
 *   5. Leaves trades, settlements, realizedPnl, forecastCache,
 *      tokenUsageLog, oracleResolutionLog, layerALastActed and
 *      structureCache completely untouched. There is no separate
 *      persisted cache of "current total exposure" anywhere in the state
 *      schema to recompute: risk/gates.ts's exposure math is always
 *      derived fresh from portfolio.positions at decision time (see
 *      currentTotalExposureTokens in loop/paperLoop.ts), never cached to
 *      disk. Fixing positions here is sufficient on its own.
 *   6. Prints a before/after summary (positions count, bankroll, total
 *      cost basis) and, ONLY if you pass --write, backs up the existing
 *      file to state/agent-state.json.bak-<timestamp> and writes the
 *      reconciled state. Without --write this is a dry run: it prints the
 *      summary and writes nothing, no backup is made either, since
 *      nothing is being overwritten.
 *
 * Bankroll derivation: bankroll = startingBankroll (read from the current
 * state file itself, not hardcoded) minus the sum of the 4 real cost
 * bases below. This assumes no other REAL cash flow happened outside
 * these 4 open positions: no real deposits beyond the starting bankroll,
 * and no real settlements/redemptions yet (a real position that had
 * already been closed would not still be open, so it would not appear in
 * REAL_POSITIONS at all). It does NOT try to reverse out the 11 ghost
 * positions' paper cost basis from the old bankroll number, since ghost
 * trades never touched a real balance, their contribution to the OLD
 * bankroll figure was already fake bookkeeping. Rederiving bankroll from
 * a clean baseline (startingBankroll minus real cost basis) is simpler
 * and more correct than trying to reverse out fake debits. Verify against
 * the real on-chain TST balance before trusting this number for anything
 * beyond an internal bookkeeping fix. If the real trades ledger later
 * turns out to include cash flows this formula does not account for
 * (e.g. a real settlement already happened), do not run this script as
 * is, recompute the target bankroll by hand first.
 *
 * Usage:
 *   npx tsx scripts/reconcile-positions.ts                    (dry run, prints only, writes nothing)
 *   npx tsx scripts/reconcile-positions.ts --write             (writes for real, backs up first)
 *   npx tsx scripts/reconcile-positions.ts --state-path <path> [--write]   (custom path, for testing against a copy)
 */
import { readJsonFile, writeJsonFileAtomic } from "../src/persistence/store.js";
import { copyFile } from "node:fs/promises";
import type { Position } from "../src/portfolio/types.js";

// The 4 real, on-chain-verified positions. Edit this list only, never the
// logic below, if the real set ever needs to change.
const REAL_POSITIONS: Array<{ marketAddress: string; costBasis: number }> = [
  { marketAddress: "0xa9b716afe262c6ee69eee5979b553c95abead376", costBasis: 33.473061 },
  { marketAddress: "0xb8fcc2c60d686b3978dd002bc20e9a4a5868f5c5", costBasis: 18.501243 },
  { marketAddress: "0x3ae4d2e7771e29a7b8d165798ed788eec82b62b6", costBasis: 11.581727 },
  { marketAddress: "0x260838dea933ec339270a8565cf8601b58a85db2", costBasis: 8.853102 },
];

interface PersistedStateShape {
  version: number;
  savedAtMs: number;
  layerALastActed: Record<string, unknown>;
  structureCache: Record<string, unknown>;
  forecastCache: Record<string, unknown>;
  tokenUsageLog: unknown[];
  portfolio: {
    startingBankroll: number;
    bankroll: number;
    positions: Position[];
    trades: unknown[];
    settlements: unknown[];
    realizedPnl: number;
  };
  oracleResolutionLog: unknown[];
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function parseArgs(argv: string[]): { write: boolean; statePath: string } {
  const write = argv.includes("--write");
  const pathFlagIdx = argv.indexOf("--state-path");
  const statePath = pathFlagIdx !== -1 && argv[pathFlagIdx + 1] ? argv[pathFlagIdx + 1]! : "state/agent-state.json";
  return { write, statePath };
}

async function main(): Promise<void> {
  const { write, statePath } = parseArgs(process.argv.slice(2));

  const current = await readJsonFile<PersistedStateShape>(statePath);
  if (!current) {
    console.error(`No state file found at ${statePath}. Nothing to reconcile.`);
    process.exitCode = 1;
    return;
  }
  if (!current.portfolio) {
    console.error(`State file at ${statePath} has no portfolio field. Refusing to proceed.`);
    process.exitCode = 1;
    return;
  }

  const currentPositions = current.portfolio.positions ?? [];
  const currentByAddress = new Map<string, Position[]>();
  for (const p of currentPositions) {
    const list = currentByAddress.get(p.marketAddress) ?? [];
    list.push(p);
    currentByAddress.set(p.marketAddress, list);
  }

  const newPositions: Position[] = [];
  const problems: string[] = [];

  for (const real of REAL_POSITIONS) {
    const matches = currentByAddress.get(real.marketAddress) ?? [];
    if (matches.length === 0) {
      problems.push(`${real.marketAddress}: not found in current positions, cannot preserve shares/outcomeIdx without inventing them, aborting.`);
      continue;
    }
    if (matches.length > 1) {
      problems.push(`${real.marketAddress}: ${matches.length} current positions match this address (different outcomeIdx). This script only handles one outcome per real market, resolve manually.`);
      continue;
    }
    const existing = matches[0]!;
    newPositions.push({
      marketAddress: existing.marketAddress,
      outcomeIdx: existing.outcomeIdx,
      outcomeLabel: existing.outcomeLabel,
      shares: existing.shares,
      costBasis: real.costBasis,
    });
  }

  if (problems.length > 0) {
    console.error("Cannot reconcile safely, found problems:");
    for (const p of problems) console.error(`  - ${p}`);
    console.error("No changes made.");
    process.exitCode = 1;
    return;
  }

  const droppedPositions = currentPositions.filter((p) => !REAL_POSITIONS.some((r) => r.marketAddress === p.marketAddress));

  const oldTotalCostBasis = sum(currentPositions.map((p) => p.costBasis));
  const newTotalCostBasis = sum(newPositions.map((p) => p.costBasis));
  const newBankroll = current.portfolio.startingBankroll - newTotalCostBasis;

  console.log("=== Reconciliation summary ===");
  console.log(`State file: ${statePath}`);
  console.log("");
  console.log("BEFORE:");
  console.log(`  positions: ${currentPositions.length}`);
  console.log(`  total cost basis: ${oldTotalCostBasis.toFixed(6)}`);
  console.log(`  bankroll: ${current.portfolio.bankroll.toFixed(6)}`);
  console.log("");
  console.log("AFTER:");
  console.log(`  positions: ${newPositions.length}`);
  console.log(`  total cost basis: ${newTotalCostBasis.toFixed(6)}`);
  console.log(`  bankroll: ${newBankroll.toFixed(6)}  (startingBankroll ${current.portfolio.startingBankroll} minus total cost basis ${newTotalCostBasis.toFixed(6)})`);
  console.log("");
  console.log(`Dropping ${droppedPositions.length} ghost position(s):`);
  for (const p of droppedPositions) {
    console.log(`  - ${p.marketAddress} outcomeIdx=${p.outcomeIdx} shares=${p.shares} costBasis=${p.costBasis}`);
  }
  console.log("");
  console.log("Keeping (shares/outcomeIdx preserved from current state, costBasis overwritten):");
  for (const p of newPositions) {
    console.log(`  - ${p.marketAddress} outcomeIdx=${p.outcomeIdx} shares=${p.shares} costBasis=${p.costBasis}`);
  }
  console.log("");
  console.log("Untouched: trades, settlements, realizedPnl, forecastCache, tokenUsageLog, oracleResolutionLog, layerALastActed, structureCache.");

  if (!write) {
    console.log("");
    console.log("DRY RUN, no changes written. Pass --write to apply.");
    return;
  }

  const backupPath = `${statePath}.bak-${Date.now()}`;
  await copyFile(statePath, backupPath);
  console.log("");
  console.log(`Backed up current state to ${backupPath}`);

  const newState: PersistedStateShape = {
    ...current,
    portfolio: {
      ...current.portfolio,
      positions: newPositions,
      bankroll: newBankroll,
    },
  };
  await writeJsonFileAtomic(statePath, newState);
  console.log(`Wrote reconciled state to ${statePath}`);
}

main().catch((err) => {
  console.error("Reconciliation failed:", err);
  process.exitCode = 1;
});
