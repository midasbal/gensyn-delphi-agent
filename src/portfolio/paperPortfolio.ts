/**
 * In-memory PAPER portfolio: bankroll, positions, trade/settlement history.
 * Never touches the chain — this is pure bookkeeping over numbers the caller
 * already obtained from real (or, for the redeem/liquidate demo, mocked)
 * quotes. See execution/ for the LIVE-mode equivalent (reads real balances).
 */
import type { Position, TradeRecord, SettlementRecord } from "./types.js";
import type { PositionValuation } from "./valuation.js";

function positionKey(marketAddress: string, outcomeIdx: number): string {
  return `${marketAddress}-${outcomeIdx}`;
}

export interface PersistedPortfolio {
  startingBankroll: number;
  bankroll: number;
  positions: Position[];
  trades: TradeRecord[];
  settlements: SettlementRecord[];
  realizedPnl: number;
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

  /**
   * Unrealized PnL: valuation.value - costBasis, summed over positions with
   * a valuation. `valuations` MUST come from portfolio/valuation.ts's
   * valuePositions() (status-aware: spot for open, deterministic 1/0 payout
   * for settled, real quoteLiquidate for expired/failed) — this method no
   * longer computes value itself, precisely because "shares * last price"
   * is wrong once a market has closed (see valuation.ts's header for why
   * this replaced that).
   */
  unrealizedPnl(valuations: Map<string, PositionValuation>): number {
    let total = 0;
    for (const [key, position] of this.positions) {
      const valuation = valuations.get(key);
      if (!valuation) continue;
      total += valuation.value - position.costBasis;
    }
    return total;
  }

  /** For persistence/index.ts. */
  exportState(): PersistedPortfolio {
    return {
      startingBankroll: this.startingBankroll,
      bankroll: this.bankroll,
      positions: [...this.positions.values()],
      trades: [...this.trades],
      settlements: [...this.settlements],
      realizedPnl: this.realizedPnl,
    };
  }

  /** For persistence/index.ts, on startup load — reconstructs a PaperPortfolio from a prior run's persisted state instead of starting fresh (startingBankroll is readonly, so this goes through the constructor rather than mutating an existing instance). */
  static fromPersisted(data: PersistedPortfolio): PaperPortfolio {
    const portfolio = new PaperPortfolio(data.startingBankroll);
    portfolio.bankroll = data.bankroll;
    for (const position of data.positions) {
      portfolio.positions.set(positionKey(position.marketAddress, position.outcomeIdx), position);
    }
    portfolio.trades.push(...data.trades);
    portfolio.settlements.push(...data.settlements);
    portfolio.realizedPnl = data.realizedPnl;
    return portfolio;
  }

  summary(valuations: Map<string, PositionValuation>) {
    const unrealized = this.unrealizedPnl(valuations);
    const provisionalCount = [...this.positions.keys()].filter((key) => valuations.get(key)?.provisional).length;
    return {
      startingBankroll: this.startingBankroll,
      bankroll: this.bankroll,
      openPositions: this.positions.size,
      tradeCount: this.trades.length,
      distinctMarkets: this.distinctMarketsTraded(),
      realizedPnl: this.realizedPnl,
      unrealizedPnl: unrealized,
      totalPnl: this.realizedPnl + unrealized,
      /** True if ANY open position's value fell back to cost basis rather than a real quote/payout — see valuation.ts. Check before trusting accountValue precisely. */
      hasProvisionalValuations: provisionalCount > 0,
      provisionalPositionCount: provisionalCount,
      accountValue:
        this.bankroll +
        [...this.positions.entries()].reduce((sum, [key, p]) => {
          const valuation = valuations.get(key);
          return sum + (valuation ? valuation.value : p.costBasis);
        }, 0),
    };
  }
}
