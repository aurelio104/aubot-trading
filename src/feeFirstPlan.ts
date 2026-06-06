/**
 * Plan fee-first: analiza oportunidad → fees → ajusta TP/SL/capital → solo viable si neto > fees.
 */
import { getConfig } from "./config.js";
import { patchStrategyParams } from "./runtimeConfig.js";
import {
  minNetEdgeUsdtForQuote,
  roundTripFeePct,
  roundTripFeeUsdt,
} from "./capitalRules.js";
import {
  computeQuoteUsdtForTrade,
  computeSmartTpSl,
  meetsMinRiskReward,
  minRiskRewardRatio,
  tpCoversFeesAndEdge,
} from "./smartCapital.js";
import type { SymbolOpportunity } from "./marketAnalysis.js";
import { pushLog } from "./log.js";

export interface FeeFirstPlan {
  symbol: string;
  quoteUsdt: number;
  roundTripFeeUsdt: number;
  roundTripFeePct: number;
  tpPct: number;
  slPct: number;
  rr: number;
  grossProfitAtTpUsdt: number;
  netProfitAtTpUsdt: number;
  netLossAtSlUsdt: number;
  minNetRequiredUsdt: number;
  viable: boolean;
  reason: string;
  applied: boolean;
}

export function feeFirstAutoEnabled(): boolean {
  return process.env.AUBOT_FEE_FIRST_AUTO !== "false";
}

export function buildFeeFirstPlan(
  freeUsdt: number,
  opp: SymbolOpportunity,
  atrPct?: number,
): FeeFirstPlan {
  const c = getConfig();
  const baseTp = opp.adaptiveTakeProfitPct ?? c.takeProfitPct ?? 3;
  const baseSl = opp.adaptiveStopLossPct ?? c.stopLossPct ?? 1.5;
  const atr = atrPct ?? opp.projectedProfitPct ?? baseTp;

  const { tpPct, slPct, rr } = computeSmartTpSl(baseTp, baseSl, atr, freeUsdt);
  const quoteUsdt = computeQuoteUsdtForTrade(freeUsdt, c.capitalPct, slPct);
  const feeUsdt = roundTripFeeUsdt(quoteUsdt);
  const feePct = roundTripFeePct();
  const grossProfitAtTpUsdt = (quoteUsdt * tpPct) / 100;
  const netProfitAtTpUsdt = grossProfitAtTpUsdt - feeUsdt;
  const grossLossAtSlUsdt = (quoteUsdt * slPct) / 100;
  const netLossAtSlUsdt = grossLossAtSlUsdt + feeUsdt;
  const minNetRequiredUsdt = minNetEdgeUsdtForQuote(quoteUsdt);

  let viable = true;
  const blockers: string[] = [];

  if (!(quoteUsdt >= c.minNotionalUsdt)) {
    viable = false;
    blockers.push(`notional ${quoteUsdt.toFixed(2)} < mín ${c.minNotionalUsdt} USDT`);
  }
  if (!meetsMinRiskReward(tpPct, slPct)) {
    viable = false;
    blockers.push(`R:R ${rr.toFixed(2)} < ${minRiskRewardRatio()}`);
  }
  if (!tpCoversFeesAndEdge(tpPct, quoteUsdt)) {
    viable = false;
    blockers.push(
      `TP ${tpPct}% no cubre fees×${process.env.AUBOT_MIN_NET_EDGE_FEE_MULT || "3"} (~${feeUsdt.toFixed(4)} USDT)`,
    );
  }
  if (netProfitAtTpUsdt < minNetRequiredUsdt) {
    viable = false;
    blockers.push(
      `neto TP ${netProfitAtTpUsdt.toFixed(4)} < mín ${minNetRequiredUsdt.toFixed(4)} USDT post-fees`,
    );
  }

  const reason = viable
    ? `fee-first OK: neto TP ~${netProfitAtTpUsdt.toFixed(4)} USDT tras fees ${feeUsdt.toFixed(4)}`
    : blockers.join("; ");

  return {
    symbol: opp.symbol,
    quoteUsdt: Number(quoteUsdt.toFixed(4)),
    roundTripFeeUsdt: Number(feeUsdt.toFixed(4)),
    roundTripFeePct: feePct,
    tpPct,
    slPct,
    rr: Number(rr.toFixed(2)),
    grossProfitAtTpUsdt: Number(grossProfitAtTpUsdt.toFixed(4)),
    netProfitAtTpUsdt: Number(netProfitAtTpUsdt.toFixed(4)),
    netLossAtSlUsdt: Number(netLossAtSlUsdt.toFixed(4)),
    minNetRequiredUsdt: Number(minNetRequiredUsdt.toFixed(4)),
    viable,
    reason,
    applied: false,
  };
}

/** Aplica TP/SL al config en memoria para la operación entrante. */
export function applyFeeFirstPlan(plan: FeeFirstPlan): FeeFirstPlan {
  if (!plan.viable) return plan;
  patchStrategyParams({
    takeProfitPct: plan.tpPct,
    stopLossPct: plan.slPct,
  });
  pushLog(
    "info",
    `fee-first ${plan.symbol}: quote=${plan.quoteUsdt} TP=${plan.tpPct}% SL=${plan.slPct}% netTP=${plan.netProfitAtTpUsdt} fees=${plan.roundTripFeeUsdt}`,
  );
  return { ...plan, applied: true };
}

export function enrichOpportunityWithFeePlan(
  opp: SymbolOpportunity,
  plan: FeeFirstPlan,
): SymbolOpportunity {
  return {
    ...opp,
    quoteUsdt: plan.quoteUsdt,
    adaptiveTakeProfitPct: plan.tpPct,
    adaptiveStopLossPct: plan.slPct,
    projectedProfitPct: plan.tpPct,
    projectedProfitUsdt: plan.grossProfitAtTpUsdt,
    netProfitUsdt: plan.netProfitAtTpUsdt,
    projectedLossUsdt: plan.netLossAtSlUsdt,
  };
}
