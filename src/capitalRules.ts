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

/** Por debajo de este umbral el spot automatizado no es viable post-fees. */
export function minViableCapitalUsdt(): number {
  return Math.max(
    15,
    Number(process.env.AUBOT_MIN_VIABLE_CAPITAL_USDT || "50") || 50,
  );
}

export function netProjectedProfitUsdt(grossProfitUsdt: number, quoteUsdt: number): number {
  const fee = (quoteUsdt * roundTripFeePct()) / 100;
  return grossProfitUsdt - fee;
}

export function minNetEdgeUsdt(): number {
  return Math.max(0.05, Number(process.env.AUBOT_MIN_NET_EDGE_USDT || "0.18") || 0.18);
}

/** Mínimo beneficio neto según tamaño de la operación (cubre fees ida+vuelta + margen). */
export function minNetEdgeUsdtForQuote(quoteUsdt: number): number {
  const base = minNetEdgeUsdt();
  if (!(quoteUsdt > 0)) return base;
  const rt = roundTripFeeUsdt(quoteUsdt);
  const mult = Number(process.env.AUBOT_MIN_NET_EDGE_FEE_MULT || "1.3") || 1.3;
  const extra = Number(process.env.AUBOT_MIN_NET_EDGE_EXTRA_USDT || "0.05") || 0.05;
  return Math.max(base, rt * mult + extra);
}

/** true si el % bruto no cubre fees round-trip + buffer configurado. */
export function grossPctBelowFeeFloor(grossPct: number): boolean {
  return grossPct < minGrossTpPct();
}

/** Fees estimados al rotar (cerrar + reabrir) sobre notional típico. */
export function rotateSwapFeeBufferUsdt(quoteUsdt: number): number {
  if (!(quoteUsdt > 0)) return 0;
  const mult = Number(process.env.AUBOT_ROTATE_FEE_MULT || "2") || 2;
  return roundTripFeeUsdt(quoteUsdt) * mult;
}

/** Beneficio neto proyectado al TP (usa netProfitUsdt del análisis si existe). */
export function projectedNetProfitUsdt(
  opp: { projectedProfitUsdt: number; netProfitUsdt?: number; quoteUsdt: number },
): number {
  if (opp.netProfitUsdt != null && Number.isFinite(opp.netProfitUsdt)) {
    return opp.netProfitUsdt;
  }
  return netProjectedProfitUsdt(opp.projectedProfitUsdt, opp.quoteUsdt);
}
