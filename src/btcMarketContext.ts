/**
 * Contexto unificado BTC — aplica a TODOS los pares candidatos.
 * Si no hay capital para BTC, opera el mejor par asequible con los mismos gates.
 */
import { fetchKlines, fetchTickerPrice } from "./binance.js";
import {
  getCachedRegime,
  detectMarketRegime,
  marketRegimeEnabled,
  longRegimeAllowed,
  longRegimeGateEnabled,
  type MarketRegime,
} from "./marketRegime.js";
import { ensureNewsContext, getCachedNews } from "./newsContext.js";
import { getActiveMacroWindow } from "./macroCalendar.js";
import { buildMacroScoreContext, macroScorePenalty } from "./macroScore.js";
import { fgBlockBelow, extremeFearMinScore } from "./capitalPolicy.js";
import { effectiveEnterMinScore } from "./runtimeConfig.js";
import { newsMinScoreBoost } from "./newsContext.js";
import { getConfig } from "./config.js";
import { computeQuoteUsdtForTrade } from "./smartCapital.js";

function btcAffordable(freeUsdt: number, quoteUsdt: number): boolean {
  const tierBtc = Number(process.env.AUBOT_TIER_BTC_USDT || "400") || 400;
  const minQuote = Number(process.env.AUBOT_BTC_MIN_QUOTE_USDT || "50") || 50;
  return freeUsdt >= tierBtc && quoteUsdt >= minQuote;
}

export const BTC_REFERENCE_SYMBOL = "BTCUSDT";

export interface BtcMarketSnapshot {
  at: string;
  symbol: string;
  price: number;
  change4hPct: number;
  change24hPct: number;
  fearGreed: number | null;
  fearGreedLabel: string;
  regime: MarketRegime | null;
  btcSentiment: number;
  macroPenalty: number;
  blockAllEntries: boolean;
  extremeFear: boolean;
  longAllowed: boolean;
  minScoreRequired: number;
  requiresStrongBuy: boolean;
  gateReason: string;
  summaryEs: string;
  affordable: boolean;
  /** Mismo comportamiento en BTC y en cualquier alt de la lista. */
  unifiedGatesApplyTo: string;
}

export function unifiedBtcGatesEnabled(): boolean {
  return process.env.AUBOT_UNIFIED_BTC_GATES !== "false";
}

export function btcReferenceEnabled(): boolean {
  return process.env.AUBOT_BTC_REFERENCE !== "false";
}

async function btcPriceChanges(): Promise<{
  price: number;
  ch4h: number;
  ch24h: number;
}> {
  try {
    const kl = await fetchKlines(BTC_REFERENCE_SYMBOL, "15m", 100);
    const price = kl.length
      ? kl[kl.length - 1].close
      : await fetchTickerPrice(BTC_REFERENCE_SYMBOL);
    let ch4h = 0;
    let ch24h = 0;
    if (kl.length >= 5) {
      const cur = kl[kl.length - 1].close;
      const h4 = kl[Math.max(0, kl.length - 17)]?.close ?? cur;
      const h24 = kl[0]?.close ?? cur;
      ch4h = h4 > 0 ? ((cur - h4) / h4) * 100 : 0;
      ch24h = h24 > 0 ? ((cur - h24) / h24) * 100 : 0;
    }
    return { price, ch4h, ch24h };
  } catch {
    return { price: 0, ch4h: 0, ch24h: 0 };
  }
}

/** Gates macro BTC que aplican igual a cada par de la lista. */
export function unifiedEntryBlocked(
  snapshot: Pick<
    BtcMarketSnapshot,
    "blockAllEntries" | "extremeFear" | "longAllowed" | "regime"
  >,
): boolean {
  if (!unifiedBtcGatesEnabled()) return false;
  if (snapshot.blockAllEntries || snapshot.extremeFear) return true;
  const bearBlock = process.env.AUBOT_BLOCK_ENTRY_BEAR !== "false";
  if (bearBlock && longRegimeGateEnabled() && snapshot.regime === "BEAR") {
    return true;
  }
  return !snapshot.longAllowed;
}

export async function buildBtcMarketContext(
  freeUsdt?: number,
): Promise<BtcMarketSnapshot> {
  const news = getCachedNews() ?? (await ensureNewsContext());
  let regime = marketRegimeEnabled() ? getCachedRegime() : null;
  if (marketRegimeEnabled() && !regime) {
    regime = await detectMarketRegime();
  }
  const macro = getActiveMacroWindow();
  const { price, ch4h, ch24h } = await btcPriceChanges();

  const ctx = buildMacroScoreContext(news, regime);
  const penalty = macroScorePenalty(ctx);
  const fg = news?.fearGreed ?? null;
  const extremeFear = fg != null && fg <= fgBlockBelow();
  const blockAll =
    (news?.blockAllEntries ?? false) || macro.active || extremeFear;
  const bearBlock = process.env.AUBOT_BLOCK_ENTRY_BEAR !== "false";
  const regimeGateOn = longRegimeGateEnabled() && bearBlock;
  const longAllowed =
    !blockAll &&
    (!regimeGateOn || longRegimeAllowed(regime?.regime));

  let minScore = Math.max(
    effectiveEnterMinScore(),
    regime?.minEnterScore ?? effectiveEnterMinScore(),
  );
  if (extremeFear) minScore = Math.max(minScore, extremeFearMinScore());
  minScore += newsMinScoreBoost(news);

  const requiresStrongBuy =
    extremeFear ||
    regime?.regime === "BEAR" ||
    (regime?.regime === "NEUTRAL" &&
      ch4h < 0 &&
      (news?.btcSentiment ?? 0) < -15);

  const c = getConfig();
  const slPct = c.stopLossPct > 0 ? c.stopLossPct : 1.5;
  const quoteUsdt =
    freeUsdt != null
      ? computeQuoteUsdtForTrade(freeUsdt, c.capitalPct, slPct)
      : 0;
  const affordable =
    freeUsdt != null && btcAffordable(freeUsdt, quoteUsdt);

  const reasons: string[] = [];
  if (extremeFear) reasons.push(`F&G ${fg} ≤ ${fgBlockBelow()} — miedo extremo`);
  if (regime?.regime === "BEAR") {
    reasons.push(`régimen BEAR — BTC ${ch4h.toFixed(1)}% (4h)`);
  }
  if (news?.blockAllEntries && news.gateReason) reasons.push(news.gateReason);
  if (macro.active) reasons.push(macro.reason);

  const gateReason =
    reasons[0] ||
    (longAllowed
      ? "contexto BTC permite evaluar alts asequibles"
      : "entradas LONG pausadas por contexto BTC");

  const summaryParts = [
    `BTC $${price > 0 ? price.toLocaleString("en-US", { maximumFractionDigits: 0 }) : "?"}`,
    `4h ${ch4h >= 0 ? "+" : ""}${ch4h.toFixed(2)}%`,
    `24h ${ch24h >= 0 ? "+" : ""}${ch24h.toFixed(2)}%`,
    regime ? `régimen ${regime.regime}` : "",
    fg != null ? `F&G ${fg}` : "",
    blockAll
      ? "ENTRADAS BLOQUEADAS (todos los pares)"
      : affordable
        ? "BTC asequible — mismos gates que alts"
        : `BTC no asequible (quote ~${quoteUsdt.toFixed(1)} USDT) — mejor alt, mismos gates`,
  ].filter(Boolean);

  return {
    at: new Date().toISOString(),
    symbol: BTC_REFERENCE_SYMBOL,
    price,
    change4hPct: Number(ch4h.toFixed(3)),
    change24hPct: Number(ch24h.toFixed(3)),
    fearGreed: fg,
    fearGreedLabel: news?.fearGreedLabel ?? "—",
    regime: regime?.regime ?? null,
    btcSentiment: news?.btcSentiment ?? 0,
    macroPenalty: penalty,
    blockAllEntries: blockAll,
    extremeFear,
    longAllowed,
    minScoreRequired: minScore,
    requiresStrongBuy,
    gateReason,
    summaryEs: summaryParts.join(" · "),
    affordable,
    unifiedGatesApplyTo: "todos los pares candidatos (mismo comportamiento)",
  };
}
