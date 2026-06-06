/**
 * Reglas inteligentes: capital pequeño, fees, R:R mínimo, racha de pérdidas (pre-entrada).
 */
import { getConfig } from "./config.js";
import {
  minGrossTpPct,
  roundTripFeePct,
  smallCapitalBelowUsdt,
} from "./capitalRules.js";
import {
  isPsychologyPauseOpen,
  psychologyPauseReason,
  openPsychologyPause,
} from "./runtimeConfig.js";
import {
  lossStreakBlockThreshold,
  lossStreakPauseHours,
  recentLossStreak,
  runLossStreakRecovery,
} from "./lossStreakRecovery.js";

export { recentLossStreak };

export function minRiskRewardRatio(): number {
  return Math.max(2, Number(process.env.AUBOT_MIN_RR_RATIO || "2") || 2);
}

/** % capital por operación (tope por banda de cuenta configurable). */
export function effectiveCapitalPct(freeUsdt: number, configuredPct: number): number {
  const pct = Math.min(100, Math.max(1, configuredPct));
  const smallBelow = smallCapitalBelowUsdt();
  if (freeUsdt > 0 && freeUsdt < smallBelow) {
    const cap = Number(process.env.AUBOT_SMALL_CAPITAL_PCT_MAX || "80") || 80;
    return Math.min(pct, cap);
  }
  if (freeUsdt > 0 && freeUsdt < 50) {
    const cap = Number(process.env.AUBOT_MED_CAPITAL_PCT_MAX || "80") || 80;
    return Math.min(pct, cap);
  }
  if (freeUsdt > 0 && freeUsdt < 100) {
    const cap = Number(process.env.AUBOT_MED_CAPITAL_PCT_MAX || "80") || 80;
    return Math.min(pct, cap);
  }
  return pct;
}

export function adaptiveTpSlEnabled(): boolean {
  return process.env.AUBOT_ADAPTIVE_TP_SL !== "false";
}

/** TP/SL con R:R mínimo y TP que cubre fees + margen neto. */
export function computeSmartTpSl(
  baseTp: number,
  baseSl: number,
  atrPct: number,
  freeUsdt: number,
): { tpPct: number; slPct: number; rr: number } {
  const minRR = minRiskRewardRatio();
  const feeFloor = minGrossTpPct();
  const minTpNet = feeFloor + (Number(process.env.AUBOT_TP_NET_BUFFER_PCT || "0.6") || 0.6);

  let tp = baseTp > 0 ? baseTp : 3;
  let sl = baseSl > 0 ? baseSl : 1.5;

  if (adaptiveTpSlEnabled()) {
    const atrTp = Number((atrPct * 1.35).toFixed(2)) || tp;
    const maxTp = freeUsdt > 0 && freeUsdt < smallCapitalBelowUsdt() ? 4.5 : 6;
    tp = Math.max(minTpNet, Math.min(maxTp, Math.max(tp, atrTp)));
    sl = Math.max(0.9, Math.min(2.2, tp / minRR));
  }

  if (tp / sl < minRR) {
    sl = Number((tp / minRR).toFixed(2));
  }
  tp = Math.max(tp, minTpNet);

  return { tpPct: tp, slPct: sl, rr: tp / sl };
}

export function meetsMinRiskReward(tpPct: number, slPct: number): boolean {
  if (!(slPct > 0)) return false;
  return tpPct / slPct >= minRiskRewardRatio() - 0.05;
}

export function preEntryLossStreakBlocked(): {
  blocked: boolean;
  streak: number;
  reason: string;
} {
  const limit = lossStreakBlockThreshold();
  const streak = recentLossStreak(7);
  if (streak < limit) {
    return { blocked: false, streak, reason: "" };
  }
  if (!isPsychologyPauseOpen()) {
    const pauseH = lossStreakPauseHours(streak);
    openPsychologyPause(
      pauseH,
      `racha ${streak} pérdidas — pausa ${pauseH}h (análisis automático)`,
      false,
    );
    void runLossStreakRecovery(streak, "tick").catch(() => {});
  }
  const pauseH = lossStreakPauseHours(streak);
  const reason = psychologyPauseReason();
  return {
    blocked: true,
    streak,
    reason:
      reason ||
      `racha ${streak} pérdidas — pausa ${pauseH}h (análisis automático en curso)`,
  };
}

/** Riesgo máximo % del capital por operación (pérdida en SL). */
export function maxRiskPctPerTrade(): number {
  return Math.max(0.5, Number(process.env.AUBOT_MAX_RISK_PCT || "2") || 2);
}

/**
 * Tamaño máximo de posición (USDT) para que la pérdida en SL = maxRiskPct del capital.
 * position × (slPct/100) = free × (maxRiskPct/100)  →  position = free × maxRisk / slPct
 */
export function quoteUsdtByFixedRisk(freeUsdt: number, slPct: number): number {
  if (!(freeUsdt > 0) || !(slPct > 0)) return 0;
  const riskUsdt = freeUsdt * (maxRiskPctPerTrade() / 100);
  return riskUsdt / (slPct / 100);
}

/** Si true, el % capital manda sobre el tope de riesgo fijo (ej. 80% configurado). */
export function prioritizeCapitalPctSizing(): boolean {
  return process.env.AUBOT_SIZING_PRIORITIZE_PCT !== "false";
}

/** USDT por trade = min(% capital efectivo, tope riesgo fijo) salvo prioritizeCapitalPct. */
export function computeQuoteUsdtForTrade(
  freeUsdt: number,
  configuredCapitalPct: number,
  slPct: number,
): number {
  const c = getConfig();
  const afterReserve = Math.max(0, freeUsdt - c.reserveUsdt);
  const pctQuote = afterReserve * (effectiveCapitalPct(freeUsdt, configuredCapitalPct) / 100);
  const riskQuote = quoteUsdtByFixedRisk(freeUsdt, slPct > 0 ? slPct : 1.5);
  let quote = prioritizeCapitalPctSizing()
    ? pctQuote
    : Math.min(pctQuote, riskQuote > 0 ? riskQuote : pctQuote);
  if (c.maxPositionUsdt > 0) quote = Math.min(quote, c.maxPositionUsdt);
  return quote;
}

/** Beneficio neto mínimo vs fees para el notional dado. */
export function tpCoversFeesAndEdge(tpPct: number, quoteUsdt: number): boolean {
  const gross = (quoteUsdt * tpPct) / 100;
  const fee = (quoteUsdt * roundTripFeePct()) / 100;
  const mult = Number(process.env.AUBOT_MIN_NET_EDGE_FEE_MULT || "3") || 3;
  return gross >= fee * mult;
}
