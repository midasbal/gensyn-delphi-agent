/**
 * In-memory PAPER portfolio: bankroll, positions, trade/settlement history.
 * Never touches the chain — this is pure bookkeeping over numbers the caller
 * already obtained from real (or, for the redeem/liquidate demo, mocked)
 * quotes. See execution/ for the LIVE-mode equivalent (reads real balances).
 */
import type { Position, TradeRecord, SettlementRecord } from "./types.js";

function positionKey(marketAddress: string, outcomeIdx: number): string {
  return `${marketAddress}-${outcomeIdx}`;
}

export class PaperPortfolio {
  bankroll: number;
  readonly startingBankroll: number;
  readonly positions = new Map<string, Position>();
  readonly trades: TradeRecord[] = [];
  readonly settlements: SettlementRecord[] = [];
  realizedPnl = 0;

  constructor(startingBankroll: number) {
    this.bankroll = startingBankroll;
    this.startingBankroll = startingBankroll;
  }

  canAfford(tokensIn: number): boolean {
    return tokensIn <= this.bankroll;
  }

  recordBuy(record: TradeRecord): void {
    this.bankroll -= record.tokensIn;
    const key = positionKey(record.marketAddress, record.outcomeIdx);
    const existing = this.positions.get(key);
    if (existing) {
      existing.shares += record.shares;
      existing.costBasis += record.tokensIn;
    } else {
      this.positions.set(key, {
        marketAddress: record.marketAddress,
        outcomeIdx: record.outcomeIdx,
        outcomeLabel: "",
        shares: record.shares,
        costBasis: record.tokensIn,
      });
    }
    this.trades.push(record);
  }

  recordSettlement(record: SettlementRecord, marketAddress: string, outcomeIdx: number): void {
    this.bankroll += record.tokensOut;
    const key = positionKey(marketAddress, outcomeIdx);
    const position = this.positions.get(key);
    if (position) {
      this.realizedPnl += record.tokensOut - position.costBasis;
      this.positions.delete(key);
    } else {
      this.realizedPnl += record.tokensOut;
    }
    this.settlements.push(record);
  }

  distinctMarketsTraded(): number {
    return new Set(this.trades.map((t) => t.marketAddress)).size;
  }

  /** Unrealized PnL: shares * livePrice - costBasis, summed over open positions whose price is known. */
  unrealizedPnl(pricesByMarket: Map<string, number[]>): number {
    let total = 0;
    for (const position of this.positions.values()) {
      const prices = pricesByMarket.get(position.marketAddress);
      const livePrice = prices?.[position.outcomeIdx];
      if (livePrice === undefined) continue;
      total += position.shares * livePrice - position.costBasis;
    }
    return total;
  }

  summary(pricesByMarket: Map<string, number[]>) {
    const unrealized = this.unrealizedPnl(pricesByMarket);
    return {
      startingBankroll: this.startingBankroll,
      bankroll: this.bankroll,
      openPositions: this.positions.size,
      tradeCount: this.trades.length,
      distinctMarkets: this.distinctMarketsTraded(),
      realizedPnl: this.realizedPnl,
      unrealizedPnl: unrealized,
      totalPnl: this.realizedPnl + unrealized,
      accountValue: this.bankroll + [...this.positions.values()].reduce((sum, p) => {
        const prices = pricesByMarket.get(p.marketAddress);
        const livePrice = prices?.[p.outcomeIdx];
        return sum + (livePrice !== undefined ? p.shares * livePrice : p.costBasis);
      }, 0),
    };
  }
}
