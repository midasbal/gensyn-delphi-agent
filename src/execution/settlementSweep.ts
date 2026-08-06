/**
 * Exit paths for closed positions: settled -> redeemMarket (pays exactly 1
 * TST per winning share — see competition.md), expired/failed -> liquidate.
 * Status is always checked first via LIQUIDATABLE_MARKET_STATUSES, never
 * assumed. Both quoteRedeem/quoteLiquidate are real on-chain reads (safe in
 * PAPER); the actual redeemMarket/liquidate writes are gated on isLive(),
 * exactly like paperTrade.ts.
 *
 * None of the 10 live competition-testnet markets are terminal yet (all
 * "open" as of this run), so both paths are also exercised here against two
 * MOCKED positions — clearly labeled `mocked: true` in every record — to
 * prove the logic actually fires. The mocked liquidate proceeds are a rough
 * approximation (shares * last known price); real liquidation proceeds
 * depend on the LMSR curve state at liquidation time, which a mock can't
 * reproduce — this is a demonstration of the code path, not a claim about
 * real payout math.
 */
import { LIQUIDATABLE_MARKET_STATUSES, quoteRedeem, quoteLiquidate, redeemMarket, liquidate, type MarketStatus } from "../sdk/client.js";
import { isLive } from "../config/index.js";
import type { PaperPortfolio } from "../portfolio/paperPortfolio.js";
import type { SettlementRecord } from "../portfolio/types.js";

export interface MockOptions {
  mocked: true;
  mockWinningOutcomeIdx?: number | null;
  mockLastPrice?: number;
}

/** Returns null if the market isn't actually terminal (still open / awaiting_settlement), or if a real quote determines nothing is owed (e.g. a losing settled outcome — quoteRedeem throws for that, per the SDK docs). */
export async function sweepPosition(
  marketAddress: `0x${string}`,
  outcomeIdx: number,
  shares: number,
  status: MarketStatus,
  portfolio: PaperPortfolio,
  mock?: MockOptions
): Promise<SettlementRecord | null> {
  const mocked = mock?.mocked ?? false;

  if (status === "settled") {
    let tokensOut: number;
    if (mocked) {
      tokensOut = mock!.mockWinningOutcomeIdx === outcomeIdx ? shares * 1 : 0;
    } else {
      try {
        const { tokensOut: raw } = await quoteRedeem(marketAddress);
        tokensOut = Number(raw) / 1e6;
      } catch {
        return null; // losing outcome, or not actually redeemable
      }
      if (isLive()) {
        await redeemMarket(marketAddress); // never reached until AGENT_MODE=live
      }
    }
    const record: SettlementRecord = { timestamp: new Date().toISOString(), marketAddress, kind: "redeem", tokensOut, mocked };
    portfolio.recordSettlement(record, marketAddress, outcomeIdx);
    return record;
  }

  if (LIQUIDATABLE_MARKET_STATUSES.includes(status)) {
    let tokensOut: number;
    if (mocked) {
      tokensOut = shares * (mock!.mockLastPrice ?? 0.5);
    } else {
      try {
        const { totalTokensOut } = await quoteLiquidate(marketAddress, [outcomeIdx]);
        tokensOut = Number(totalTokensOut) / 1e6;
      } catch {
        return null;
      }
      if (isLive()) {
        await liquidate(marketAddress, [outcomeIdx]); // never reached until AGENT_MODE=live
      }
    }
    const record: SettlementRecord = { timestamp: new Date().toISOString(), marketAddress, kind: "liquidate", tokensOut, mocked };
    portfolio.recordSettlement(record, marketAddress, outcomeIdx);
    return record;
  }

  return null; // not terminal yet (open / awaiting_settlement)
}
