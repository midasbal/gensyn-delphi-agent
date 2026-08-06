/**
 * Books a trade that has already passed the full risk gate (risk/gates.ts)
 * and already has a real, slippage-clipped on-chain quote. PAPER mode is the
 * ONLY mode until AGENT_MODE=live is explicitly set — see config/index.ts.
 *
 * The mode gate here is hard and local: `isLive()` is checked at the one
 * place buyShares could be called, not inferred from anything upstream (a
 * loaded signer key, a passed quote, etc.). In PAPER, this function updates
 * bookkeeping ONLY — it never calls sdk/client.ts's buyShares.
 */
import { isLive } from "../config/index.js";
import { buyShares, ensureTokenApproval } from "../sdk/client.js";
import type { PaperPortfolio } from "../portfolio/paperPortfolio.js";
import type { TradeRecord } from "../portfolio/types.js";
import type { ClippedTrade } from "../risk/types.js";
import { logTrade } from "../logging/index.js";

const sharesToBigint = (n: number): bigint => BigInt(Math.round(n * 1e18));
const tokensToBigint = (n: number): bigint => BigInt(Math.round(n * 1e6));

export async function executeTrade(trade: ClippedTrade, portfolio: PaperPortfolio): Promise<TradeRecord> {
  const record: TradeRecord = {
    timestamp: new Date().toISOString(),
    marketAddress: trade.market.address,
    outcomeIdx: trade.outcomeIdx,
    question: trade.market.question,
    shares: trade.finalShares,
    tokensIn: trade.finalTokensIn,
    effectivePrice: trade.effectivePrice,
    slippagePct: trade.slippagePct,
    quotedPrice: trade.price,
    ourProbability: trade.probability,
    edge: trade.edge,
  };

  if (isLive()) {
    // Never reached until AGENT_MODE=live is explicitly set with a funded,
    // registered wallet. Slippage cap reuses the tolerance already validated
    // by the quote this trade was built from (risk/gates.ts step f).
    const maxTokensIn = tokensToBigint(trade.finalTokensIn * (1 + trade.slippagePct + 0.02));
    await ensureTokenApproval(trade.market.address, maxTokensIn);
    await buyShares(trade.market.address, trade.outcomeIdx, sharesToBigint(trade.finalShares), maxTokensIn);
  }

  // Bookkeeping + structured logging happen unconditionally so PAPER and
  // LIVE produce the same shape of record/log; only the on-chain call above
  // is mode-gated. Logged HERE (the single choke point every fill passes
  // through — real pipeline trades via loop/paperLoop.ts AND ad-hoc ones
  // like scripts/paper-run.ts's synthetic gate demo) rather than at each
  // call site, so no fill can accidentally skip the trade log.
  portfolio.recordBuy(record);
  await logTrade(record).catch(() => {});
  return record;
}
