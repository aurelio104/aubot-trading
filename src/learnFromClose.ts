import type { ClosedTrade } from "./tradeLedger.js";

export interface TradeLesson {
  at: string;
  tradeId: string;
  symbol: string;
  pnlUsdt: number;
  pnlPct: number;
  closeReason: string;
  severity: "info" | "warn" | "error";
  lessonEs: string;
  action?: string;
  tags: string[];
}

export function buildLessons(trade: ClosedTrade): TradeLesson[] {
  const lessons: TradeLesson[] = [];
  const base = {
    at: trade.closedAt,
    tradeId: trade.id,
    symbol: trade.symbol,
    pnlUsdt: trade.pnlUsdt,
    pnlPct: trade.pnlPct,
    closeReason: trade.closeReason,
  };

  const tags: string[] = [];
  if (trade.pnlUsdt < 0) tags.push("loss");
  else if (trade.pnlUsdt > 0) tags.push("win");
  if (/stop-loss/i.test(trade.closeReason)) tags.push("stop_loss");
  if (/take-profit|trailing/i.test(trade.closeReason)) tags.push("take_profit");
  if (/time-exit/i.test(trade.closeReason)) tags.push("time_exit");
  if (trade.feesUsdt > 0 && trade.grossPnlUsdt > 0 && trade.pnlUsdt <= 0) {
    tags.push("fees_ate_profit");
  }
  const feeDrag =
    trade.feesUsdt > 0 &&
    trade.grossPnlUsdt > 0 &&
    trade.pnlUsdt > 0 &&
    trade.pnlUsdt < trade.feesUsdt * 0.5;
  if (feeDrag) {
    tags.push("win_below_fee_margin");
  }

  if (trade.pnlUsdt < 0) {
    if (/stop-loss/i.test(trade.closeReason)) {
      lessons.push({
        ...base,
        severity: "warn",
        lessonEs: `SL en ${trade.symbol}: entrada score=${trade.entryScore ?? "?"} RSI=${trade.entryRsi?.toFixed(1) ?? "?"} — subir selectividad (MTF/noticias) antes de reentrar este par`,
        action: "raise_min_score|check_mtf",
        tags: [...tags, "sl_review"],
      });
    } else if (/time-exit/i.test(trade.closeReason)) {
      lessons.push({
        ...base,
        severity: "info",
        lessonEs: `${trade.symbol} cerró por tiempo sin alcanzar TP — mercado lateral; considerar TP adaptativo más bajo en capital pequeño`,
        action: "review_adaptive_tp",
        tags: [...tags, "stagnant"],
      });
    } else {
      lessons.push({
        ...base,
        severity: "warn",
        lessonEs: `Pérdida en ${trade.symbol} (${trade.pnlUsdt.toFixed(4)} USDT): revisar si la entrada cumplía todos los gates de /decision`,
        action: "verify_decision_gate",
        tags: [...tags, "loss_review"],
      });
    }
  }

  if (trade.feesUsdt >= Math.abs(trade.pnlUsdt) * 0.4 && trade.pnlUsdt <= 0) {
    lessons.push({
      ...base,
      severity: "error",
      lessonEs: `Fees (${trade.feesUsdt.toFixed(4)} USDT) dominaron el resultado — subir AUBOT_MIN_NET_EDGE_USDT o evitar reentradas rápidas`,
      action: "raise_min_net_edge",
      tags: [...tags, "fee_drag"],
    });
  }

  if ((trade.entryScore ?? 0) >= 80 && trade.pnlUsdt < 0) {
    lessons.push({
      ...base,
      severity: "warn",
      lessonEs: `Score alto (${trade.entryScore}) pero PnL negativo — el contexto macro/noticias pudo invalidar la señal técnica`,
      action: "respect_news_gate",
      tags: [...tags, "high_score_loss"],
    });
  }

  if (feeDrag) {
    lessons.push({
      ...base,
      severity: "warn",
      lessonEs: `Ganancia bruta +${trade.grossPnlUsdt.toFixed(4)} pero neto casi comido por fees (${trade.feesUsdt.toFixed(4)} USDT) — subir TP mínimo o AUBOT_MIN_NET_EDGE_USDT`,
      action: "raise_min_net_edge|raise_tp",
      tags: [...tags, "fee_margin_thin"],
    });
  }

  if (trade.pnlUsdt > 0 && /take-profit|trailing/i.test(trade.closeReason)) {
    lessons.push({
      ...base,
      severity: "info",
      lessonEs: `TP/trailing exitoso en ${trade.symbol} (+${trade.pnlUsdt.toFixed(4)} USDT neto, fees ${trade.feesUsdt.toFixed(4)}) — patrón a favor`,
      tags: [...tags, "pattern_ok"],
    });
  }

  if (lessons.length === 0) {
    lessons.push({
      ...base,
      severity: "info",
      lessonEs: `Cierre ${trade.symbol}: PnL ${trade.pnlUsdt >= 0 ? "+" : ""}${trade.pnlUsdt.toFixed(4)} USDT — registrado para scorecard`,
      tags,
    });
  }

  return lessons;
}
