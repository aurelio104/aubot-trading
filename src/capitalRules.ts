/** Reglas de capital conservadoras (P1/P5). */
export function roundTripFeePct(): number {
  return Math.max(0, Number(process.env.AUBOT_ROUND_TRIP_FEE_PCT || "0.2") || 0.2);
}

export function roundTripFeeUsdt(notionalUsdt: number): number {
  return (notionalUsdt * roundTripFeePct()) / 100;
}

/** Subida bruta mínima (%) para cubrir fees round-trip + buffer neto. */
export function minGrossTpPct(): number {
  const buffer =
    Number(process.env.AUBOT_FEE_PROFIT_BUFFER_PCT || "0.15") || 0.15;
  return roundTripFeePct() + buffer;
}

export function feeAwareExitsEnabled(): boolean {
  return process.env.AUBOT_FEE_AWARE_EXITS !== "false";
}

/** PnL neto estimado tras fees (compra+venta sobre notional de entrada). */
export function netPnlUsdt(
  entry: number,
  exit: number,
  qty: number,
): number {
  const gross = (exit - entry) * qty;
  return gross - roundTripFeeUsdt(entry * qty);
}

export function netPnlPct(entry: number, exit: number): number {
  if (entry <= 0) return 0;
  return ((exit / entry - 1) * 100) - roundTripFeePct();
}

export function maxWeeklyLossUsdt(): number {
  return Math.max(0, Number(process.env.AUBOT_MAX_WEEKLY_LOSS_USDT || "1.5") || 1.5);
}

export function maxDailyLossPct(): number {
  return Math.max(0, Number(process.env.AUBOT_MAX_DAILY_LOSS_PCT || "3") || 3);
}

export function smallCapitalMaxTradesDay(): number {
  const v = Number(process.env.AUBOT_SMALL_CAPITAL_MAX_TRADES || "2");
  return Number.isFinite(v) && v > 0 ? v : 2;
}

export function smallCapitalBelowUsdt(): number {
  return Number(process.env.AUBOT_SMALL_CAPITAL_BELOW || "25") || 25;
}

export function netProjectedProfitUsdt(grossProfitUsdt: number, quoteUsdt: number): number {
  const fee = (quoteUsdt * roundTripFeePct()) / 100;
  return grossProfitUsdt - fee;
}

export function minNetEdgeUsdt(): number {
  return Math.max(0.05, Number(process.env.AUBOT_MIN_NET_EDGE_USDT || "0.12") || 0.12);
}
