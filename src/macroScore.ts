/**
 * Ajuste del score técnico según contexto macro (F&G, régimen, sentimiento BTC).
 */
import type { NewsSnapshot } from "./newsContext.js";
import type { RegimeSnapshot, MarketRegime } from "./marketRegime.js";
import type { SymbolOpportunity } from "./marketAnalysis.js";

export interface MacroScoreContext {
  regime: MarketRegime | null;
  fearGreed: number | null;
  btcSentiment: number;
}

export function buildMacroScoreContext(
  news?: NewsSnapshot | null,
  regime?: RegimeSnapshot | null,
): MacroScoreContext {
  return {
    regime: regime?.regime ?? null,
    fearGreed: news?.fearGreed ?? null,
    btcSentiment: news?.btcSentiment ?? 0,
  };
}

/** Penalización al buyScore por contexto macro adverso. */
export function macroScorePenalty(ctx: MacroScoreContext): number {
  let penalty = 0;
  if (ctx.regime === "BEAR") penalty += 28;
  if (ctx.fearGreed != null && ctx.fearGreed <= 25) {
    penalty += Number(process.env.AUBOT_FG_EXTREME_SCORE_BOOST || "15") || 15;
  } else if (ctx.fearGreed != null && ctx.fearGreed <= 35) {
    penalty += 8;
  }
  if (ctx.btcSentiment <= -40) penalty = Math.max(penalty, 18);
  else if (ctx.btcSentiment <= -25) penalty = Math.max(penalty, 12);
  else if (ctx.btcSentiment <= -12) penalty = Math.max(penalty, 6);
  return penalty;
}

function downgradeSignal(
  signal: SymbolOpportunity["signal"],
  penalty: number,
): SymbolOpportunity["signal"] {
  if (penalty >= 25 && (signal === "strong_buy" || signal === "buy")) return "hold";
  if (penalty >= 15 && signal === "strong_buy") return "buy";
  return signal;
}

/** Aplica penalización macro y degrada señal si el score ignora contexto. */
export function enrichCandidatesWithMacro(
  candidates: SymbolOpportunity[],
  news?: NewsSnapshot | null,
  regime?: RegimeSnapshot | null,
): void {
  const ctx = buildMacroScoreContext(news, regime);
  const penalty = macroScorePenalty(ctx);
  if (penalty <= 0) return;

  for (const c of candidates) {
    c.macroPenalty = penalty;
    c.rawBuyScore = c.rawBuyScore ?? c.buyScore;
    c.buyScore = Math.max(0, c.buyScore - penalty);
    c.signal = downgradeSignal(c.signal, penalty);
    if (penalty >= 15) {
      c.reason = `${c.reason}; macro −${penalty} (F&G/régimen)`;
    }
  }
}
