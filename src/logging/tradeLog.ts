/**
 * Structured trade log — one JSON line per fill (paper or, once LIVE, real).
 * TradeRecord already IS the lean shape (see portfolio/types.ts); this just
 * appends it with a `mode` tag so a log file spanning a PAPER-to-LIVE
 * transition stays unambiguous about which fills were simulated.
 */
import { appendJsonLine } from "./writer.js";
import { AGENT_MODE } from "../config/index.js";
import type { TradeRecord, SettlementRecord } from "../portfolio/types.js";

export async function logTrade(record: TradeRecord): Promise<void> {
  await appendJsonLine("trades", { ...record, mode: AGENT_MODE });
}

export async function logSettlement(record: SettlementRecord): Promise<void> {
  await appendJsonLine("trades", { ...record, mode: AGENT_MODE, type: "settlement" });
}
