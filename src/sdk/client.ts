/**
 * Thin wrapper over DelphiClient, pinned to competition-testnet.
 *
 * Every method here is a direct pass-through to the SDK — no strategy logic
 * lives in this file. Its job is a single choke point for network config and
 * for the internal-vs-raw Market boundary (markets/ normalizes what this
 * returns).
 */
import "dotenv/config";
import {
  DelphiClient,
  LIQUIDATABLE_MARKET_STATUSES,
  type Market,
  type MarketStatus,
  type Position,
  type QuoteBuyResponse,
  type QuoteSellResponse,
  type QuoteRedeemResponse,
  type QuoteLiquidateResponse,
  type BuySharesResponse,
  type SellSharesResponse,
  type RedeemMarketResponse,
  type RedeemPositionsResponse,
  type LiquidateResponse,
  type EnsureTokenApprovalResponse,
} from "@gensyn-ai/gensyn-delphi-sdk";
import { network } from "../config/index.js";

let _client: DelphiClient | null = null;

/** Singleton — constructing DelphiClient is cheap but there's no reason to do it twice. */
export function getClient(): DelphiClient {
  if (!_client) {
    _client = new DelphiClient({ network: network.network });
  }
  return _client;
}

export { LIQUIDATABLE_MARKET_STATUSES };
export type { Market, MarketStatus, Position };

/** Competition markets can have >2 outcomes (LMSR is not binary-only) — see competition.md. */
export async function listOpenMarkets(opts?: { limit?: number; skip?: number }): Promise<Market[]> {
  const { markets } = await getClient().listMarkets({
    status: "open",
    limit: opts?.limit ?? 50,
    skip: opts?.skip ?? 0,
    ...(network.competitionId ? { competitionId: network.competitionId } : {}),
    pricesAndImpliedProbabilities: true,
  });
  // A null/empty result is a valid state (no active competition, or it has no
  // open markets yet) — never treated as an error by callers of this function.
  return markets ?? [];
}

export async function listMarketsByStatus(status: MarketStatus, opts?: { limit?: number; skip?: number }): Promise<Market[]> {
  const { markets } = await getClient().listMarkets({
    status,
    limit: opts?.limit ?? 50,
    skip: opts?.skip ?? 0,
    ...(network.competitionId ? { competitionId: network.competitionId } : {}),
    pricesAndImpliedProbabilities: true,
  });
  return markets ?? [];
}

export async function getMarketByAddress(id: string): Promise<Market> {
  return getClient().getMarket({
    id,
    ...(network.competitionId ? { competitionId: network.competitionId } : {}),
    pricesAndImpliedProbabilities: true,
  });
}

export async function getMarketStatus(marketAddress: `0x${string}`): Promise<MarketStatus> {
  return getClient().getMarketStatus(marketAddress);
}

export async function quoteBuy(marketAddress: `0x${string}`, outcomeIdx: number, sharesOut: bigint): Promise<QuoteBuyResponse> {
  return getClient().quoteBuy({ marketAddress, outcomeIdx, sharesOut });
}

export async function quoteSell(marketAddress: `0x${string}`, outcomeIdx: number, sharesIn: bigint): Promise<QuoteSellResponse> {
  return getClient().quoteSell({ marketAddress, outcomeIdx, sharesIn });
}

export async function quoteRedeem(marketAddress: `0x${string}`, account?: `0x${string}`): Promise<QuoteRedeemResponse> {
  return getClient().quoteRedeem({ marketAddress, ...(account ? { account } : {}) });
}

export async function quoteLiquidate(
  marketAddress: `0x${string}`,
  outcomeIndices: number[],
  account?: `0x${string}`
): Promise<QuoteLiquidateResponse> {
  return getClient().quoteLiquidate({ marketAddress, outcomeIndices, ...(account ? { account } : {}) });
}

/** Places an on-chain buy. Callers MUST gate this behind isLive() — see execution/. */
export async function buyShares(
  marketAddress: `0x${string}`,
  outcomeIdx: number,
  sharesOut: bigint,
  maxTokensIn: bigint
): Promise<BuySharesResponse> {
  return getClient().buyShares({ marketAddress, outcomeIdx, sharesOut, maxTokensIn });
}

/** Idempotent — only sends a tx if the current allowance is below minimumAmount. Callers MUST gate this behind isLive() — see execution/. */
export async function ensureTokenApproval(marketAddress: `0x${string}`, minimumAmount: bigint): Promise<EnsureTokenApprovalResponse> {
  return getClient().ensureTokenApproval({ marketAddress, minimumAmount });
}

/** Places an on-chain sell. Callers MUST gate this behind isLive() — see execution/. */
export async function sellShares(
  marketAddress: `0x${string}`,
  outcomeIdx: number,
  sharesIn: bigint,
  minTokensOut: bigint
): Promise<SellSharesResponse> {
  return getClient().sellShares({ marketAddress, outcomeIdx, sharesIn, minTokensOut });
}

/** Redeem a settled market. Callers MUST gate this behind isLive() — see execution/. */
export async function redeemMarket(marketAddress: `0x${string}`): Promise<RedeemMarketResponse> {
  return getClient().redeemMarket({ marketAddress });
}

/** Batch redeem. Callers MUST gate this behind isLive() — see execution/. */
export async function redeemPositions(marketAddresses: `0x${string}`[]): Promise<RedeemPositionsResponse> {
  return getClient().redeemPositions({ marketAddresses });
}

/** Liquidate an expired/failed market. Callers MUST gate this behind isLive() — see execution/. */
export async function liquidate(marketAddress: `0x${string}`, outcomeIndices: number[]): Promise<LiquidateResponse> {
  return getClient().liquidate({ marketAddress, outcomeIndices });
}

export async function listPositions(wallet: string, opts?: { redeemedOrLiquidated?: boolean; limit?: number }): Promise<Position[]> {
  const { positions } = await getClient().listPositions({
    wallet,
    ...(opts?.redeemedOrLiquidated !== undefined ? { redeemedOrLiquidated: opts.redeemedOrLiquidated } : {}),
    limit: opts?.limit ?? 50,
  });
  return positions ?? [];
}

export async function getWalletAddress(): Promise<`0x${string}`> {
  const { address } = await getClient().getSigner();
  return address;
}

export async function getEthBalance(): Promise<bigint> {
  return getClient().getEthBalance();
}

export async function getTstBalance(): Promise<{ balance: bigint; decimals: number }> {
  return getClient().getErc20BalanceWithDecimals();
}

export function getSubgraph() {
  return getClient().getSubgraph();
}
