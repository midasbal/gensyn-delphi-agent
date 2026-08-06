export interface Position {
  marketAddress: `0x${string}`;
  outcomeIdx: number;
  outcomeLabel: string;
  /** Human-readable share count (not the 18-decimal bigint). */
  shares: number;
  /** TST spent acquiring this position (cost basis). */
  costBasis: number;
}

export interface TradeRecord {
  timestamp: string;
  marketAddress: `0x${string}`;
  outcomeIdx: number;
  question: string;
  shares: number;
  tokensIn: number;
  effectivePrice: number;
  slippagePct: number;
  quotedPrice: number;
  ourProbability: number;
  edge: number;
}

export interface SettlementRecord {
  timestamp: string;
  marketAddress: `0x${string}`;
  kind: "redeem" | "liquidate";
  tokensOut: number;
  mocked: boolean;
}
