/**
 * Límites de riesgo escalados al capital real (ej. ~$21 USDT).
 */
import { getConfig } from "./config.js";
import { roundTripFeePct } from "./capitalRules.js";

export function maxRiskPctPerTradePolicy(): number {
  return Math.max(0.5, Number(process.env.AUBOT_MAX_RISK_PCT || "2") || 2);
}

export function maxDailyLossPct(): number {
  return Math.max(0.5, Number(process.env.AUBOT_MAX_DAILY_LOSS_PCT || "3") || 3);
}

export function maxWeeklyLossPct(): number {
  return Math.max(1, Number(process.env.AUBOT_MAX_WEEKLY_LOSS_PCT || "8") || 8);
}

export function autoOffWeeklyLossPct(): number {
  return Math.max(3, Number(process.env.AUBOT_AUTO_OFF_WEEKLY_LOSS_PCT || "5") || 5);
}

export function maxDailyLossUsdt(freeUsdt: number): number {
  const c = getConfig();
  if (c.maxDailyLossUsdt > 0) return c.maxDailyLossUsdt;
  if (!(freeUsdt > 0)) return 0;
  return Number(((freeUsdt * maxDailyLossPct()) / 100).toFixed(4));
}

export function maxWeeklyLossUsdt(freeUsdt: number): number {
  const fixed = Number(process.env.AUBOT_MAX_WEEKLY_LOSS_USDT || "0") || 0;
  if (fixed > 0) return fixed;
  if (!(freeUsdt > 0)) return 0;
  return Number(((freeUsdt * maxWeeklyLossPct()) / 100).toFixed(4));
}

export function maxRiskUsdt(freeUsdt: number): number {
  if (!(freeUsdt > 0)) return 0;
  return Number(((freeUsdt * maxRiskPctPerTradePolicy()) / 100).toFixed(4));
}

/** @deprecated Sin bloqueo demo — capital actual siempre real si /decision OK */
export function minRealTradingCapitalUsdt(): number {
  return 0;
}

/** @deprecated Sin modo demo forzado */
export function demoOnlyBelowUsdt(): number {
  return 0;
}

export function minNetEdgeFeeMult(): number {
  return Math.max(2, Number(process.env.AUBOT_MIN_NET_EDGE_FEE_MULT || "3") || 3);
}

export function minNetEdgeUsdtForQuote(quoteUsdt: number, freeUsdt: number): number {
  const fee = (quoteUsdt * roundTripFeePct()) / 100;
  return fee * minNetEdgeFeeMult();
}

export function extremeFearMinScore(): number {
  return Math.max(80, Number(process.env.AUBOT_EXTREME_FEAR_MIN_SCORE || "90") || 90);
}

export function extremeFearHighScore(): number {
  return Math.max(90, Number(process.env.AUBOT_EXTREME_FEAR_HIGH_SCORE || "95") || 95);
}

export function fgBlockBelow(): number {
  return Number(process.env.AUBOT_FG_BLOCK_BELOW || "25") || 25;
}

export function rsiEntryMin(): number {
  return Math.max(15, Number(process.env.AUBOT_MEAN_REVERSION_RSI_MIN || "20") || 20);
}

export function rsiEntryMax(): number {
  return Math.min(40, Number(process.env.AUBOT_MEAN_REVERSION_RSI_MAX || "35") || 35);
}

/** @deprecated Usar lossStreakPauseHours(streak) en lossStreakRecovery.ts */
export function lossStreakPauseHours(): number {
  return Math.max(1, Number(process.env.AUBOT_LOSS_STREAK_PAUSE_H2 || "1") || 1);
}

export function maxTradesPerDayEffective(freeUsdt: number): number {
  const c = getConfig();
  if (c.maxTradesPerDay > 0) return c.maxTradesPerDay;
  return Number(process.env.AUBOT_MAX_TRADES_PER_DAY || "1") || 1;
}
