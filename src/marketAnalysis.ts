import { binanceBaseUrl, fetchKlines, fetchTickerPrice } from "./binance.js";
import { getConfig } from "./config.js";
import { hasOpenPosition } from "./position.js";
import { getFreeUsdt } from "./capital.js";
import { bollinger, rsi, toSeries, atr } from "./indicators.js";
import { getSymbolFilters } from "./exchangeInfo.js";
import { setTradingSymbol, getTradingSymbol } from "./tradingSymbol.js";
import { pushLog } from "./log.js";
import {
  isBlacklisted,
  stagnantMinScore,
} from "./runtimeConfig.js";
import { getScoreWeights } from "./scoreWeights.js";
import { computeSmartTpSl, computeQuoteUsdtForTrade } from "./smartCapital.js";
import { newsContextEnabled, ensureNewsContext, getCachedNews } from "./newsContext.js";
import {
  getCachedRegime,
  detectMarketRegime,
  marketRegimeEnabled,
} from "./marketRegime.js";
import { enrichCandidatesWithMacro } from "./macroScore.js";
import { normalizeRsi, rsiExtremeLow, formatRsiLabel } from "./rsiFormat.js";
import {
  BTC_REFERENCE_SYMBOL,
  btcReferenceEnabled,
  buildBtcMarketContext,
  type BtcMarketSnapshot,
} from "./btcMarketContext.js";
import {
  buildAdaptiveCandidatePlan,
  type AdaptiveCandidatePlan,
} from "./adaptiveCandidates.js";

export interface SymbolOpportunity {
  symbol: string;
  price: number;
  rsi: number;
  distToBbLowerPct: number;
  buyScore: number;
  rawBuyScore?: number;
  macroPenalty?: number;
  signal: "strong_buy" | "buy" | "hold" | "sell";
  affordable: boolean;
  quoteUsdt: number;
  projectedProfitPct: number;
  projectedProfitUsdt: number;
  projectedLossUsdt: number;
  netProfitUsdt?: number;
  etaHoursMin: number;
  etaHoursMax: number;
  reason: string;
  volumeScore?: number;
  volumeOk?: boolean;
  volumeRatio?: number;
  adaptiveTakeProfitPct?: number;
  adaptiveStopLossPct?: number;
}

export interface MarketAnalysisResult {
  at: string;
  freeUsdt: number;
  activeSymbol: string;
  takeProfitPct: number;
  stopLossPct: number;
  candidates: SymbolOpportunity[];
  best: SymbolOpportunity | null;
  /** Referencia BTC — mismos gates macro para todos los pares. */
  btcContext?: BtcMarketSnapshot | null;
  /** Plan de pares según capital (expansión automática). */
  candidatePlan?: AdaptiveCandidatePlan | null;
}

function signalRank(signal: SymbolOpportunity["signal"]): number {
  if (signal === "strong_buy") return 2;
  if (signal === "buy") return 1;
  return 0;
}

/** Mejor oportunidad: score → strong_buy → RSI más bajo → ETA más corta. */
export function compareOpportunities(
  a: SymbolOpportunity,
  b: SymbolOpportunity,
): number {
  if (a.affordable !== b.affordable) return a.affordable ? -1 : 1;
  if (b.buyScore !== a.buyScore) return b.buyScore - a.buyScore;
  const sig = signalRank(b.signal) - signalRank(a.signal);
  if (sig !== 0) return sig;
  if (a.rsi !== b.rsi) return a.rsi - b.rsi;
  const etaA = a.etaHoursMax > 0 ? a.etaHoursMax : 999;
  const etaB = b.etaHoursMax > 0 ? b.etaHoursMax : 999;
  if (etaA !== etaB) return etaA - etaB;
  return a.symbol.localeCompare(b.symbol);
}

function intervalHours(interval: string): number {
  const m = interval.match(/^(\d+)(m|h|d)$/);
  if (!m) return 0.25;
  const n = Number(m[1]);
  if (m[2] === "m") return n / 60;
  if (m[2] === "h") return n;
  return n * 24;
}

export async function analyzeSymbol(
  symbol: string,
  freeUsdt: number,
): Promise<SymbolOpportunity> {
  const c = getConfig();
  const klines = await fetchKlines(symbol, c.klineInterval, 120);
  const closed = klines.slice(0, -1);
  const series = toSeries(closed);
  const i = closed.length - 1;
  const rsiValues = rsi(series.closes, c.rsiPeriod);
  const bb = bollinger(series.closes, c.bbPeriod, c.bbStdDev);
  const atrValues = atr(series.highs, series.lows, series.closes, 14);
  const r = normalizeRsi(rsiValues[i] ?? 50);
  const close = series.closes[i] ?? 0;
  const lower = bb.lower[i] ?? close;
  const upper = bb.upper[i] ?? close;
  const price = close || (await fetchTickerPrice(symbol));
  const atrPct = close > 0 && atrValues[i] ? (atrValues[i] / close) * 100 : 0.5;

  const w = getScoreWeights();
  let buyScore = 0;
  if (r < c.rsiBuyBelow) buyScore += w.rsiStrong;
  else if (r < 45) buyScore += w.rsiWeak;
  if (close < lower) buyScore += w.bbLower;
  else if (close < bb.middle[i]) buyScore += w.bbMid;
  const distToBbLowerPct =
    lower > 0 ? ((close - lower) / lower) * 100 : 0;

  const volSlice = series.volumes.slice(Math.max(0, i - 23), i + 1);
  const volQuote = volSlice.reduce((a, v) => a + v, 0) * close;
  const volumeScore = Math.min(
    15,
    Math.max(0, Math.log10(Math.max(volQuote, 1)) * 2.5),
  );
  buyScore += Math.round(volumeScore * w.volumeMult);
  if (atrPct > 6) buyScore -= w.atrHighPenalty;
  else if (atrPct > 3) buyScore -= w.atrMidPenalty;
  else if (atrPct >= 0.8 && atrPct <= 2.5) buyScore += w.atrSweetBonus;
  buyScore = Math.max(0, Math.min(100, buyScore));

  const vols = series.volumes;
  const avgVol =
    vols.slice(Math.max(0, i - 19), i + 1).reduce((a, v) => a + v, 0) /
    Math.min(20, i + 1);
  const volMult = Math.max(1, Number(process.env.AUBOT_ENTRY_VOLUME_MULT || "1") || 1);
  const volumeOk = avgVol <= 0 || vols[i] > avgVol * volMult;
  const volumeRatio = avgVol > 0 ? Number((vols[i] / avgVol).toFixed(2)) : 1;
  const rsiMin = Math.max(12, Number(process.env.AUBOT_MEAN_REVERSION_RSI_MIN || "18") || 18);

  const baseTp = c.takeProfitPct > 0 ? c.takeProfitPct : 3.5;
  const baseSl = c.stopLossPct > 0 ? c.stopLossPct : 1.5;
  const { tpPct: useTp, slPct: useSl } = computeSmartTpSl(
    baseTp,
    baseSl,
    atrPct,
    freeUsdt,
  );
  const quote = computeQuoteUsdtForTrade(freeUsdt, c.capitalPct, useSl);

  let signal: SymbolOpportunity["signal"] = "hold";
  if (r >= rsiMin && r < c.rsiBuyBelow && close < lower && volumeOk) {
    signal = "strong_buy";
  } else if (r < c.rsiBuyBelow && close < lower) {
    signal = volumeOk && r >= rsiMin ? "buy" : "hold";
  } else if (r < c.rsiBuyBelow + 5 && close <= lower * 1.002 && volumeOk && r >= rsiMin) {
    signal = "buy";
  } else if (r > c.rsiSellAbove || close > upper) signal = "sell";
  let affordable = quote >= c.minNotionalUsdt;
  try {
    const f = await getSymbolFilters(symbol, binanceBaseUrl());
    affordable = affordable && quote >= f.minNotional && quote / price >= f.minQty;
  } catch {
    affordable = false;
  }

  const projectedProfitUsdt = (quote * useTp) / 100;
  const projectedLossUsdt = (quote * useSl) / 100;
  const feePct = Math.max(0, Number(process.env.AUBOT_ROUND_TRIP_FEE_PCT || "0.2") || 0.2);
  const netProfitUsdt = projectedProfitUsdt - (quote * feePct) / 100;

  const periodH = intervalHours(c.klineInterval);
  const candlesToTp = atrPct > 0 ? Math.max(1, useTp / atrPct) : 12;
  const etaHoursMin = Math.max(periodH, candlesToTp * periodH * 0.6);
  const etaHoursMax = candlesToTp * periodH * 2.5;

  const reasons: string[] = [];
  if (signal === "strong_buy") reasons.push("RSI en zona + BB inferior + volumen OK");
  else if (signal === "buy") reasons.push("RSI favorable con volumen");
  else if (rsiExtremeLow(r) && close < lower) {
    reasons.push(`RSI ${formatRsiLabel(r)} — no atrapar cuchillo`);
  } else if (r < rsiMin && close < lower) reasons.push(`RSI ${r.toFixed(1)} < ${rsiMin} — esperar confirmación`);
  else if (!volumeOk && r < c.rsiBuyBelow) reasons.push(`volumen ${volumeRatio}× media — sin confirmación`);
  else if (signal === "sell") reasons.push("sobrecompra / techo BB");
  else reasons.push("sin entrada clara aún");
  if (!affordable) reasons.push("capital insuficiente para mínimo del par");

  return {
    symbol,
    price,
    rsi: r,
    distToBbLowerPct,
    buyScore,
    signal,
    affordable,
    quoteUsdt: quote,
    projectedProfitPct: useTp,
    projectedProfitUsdt: Number(projectedProfitUsdt.toFixed(4)),
    projectedLossUsdt: Number(projectedLossUsdt.toFixed(4)),
    netProfitUsdt: Number(netProfitUsdt.toFixed(4)),
    etaHoursMin: Number(etaHoursMin.toFixed(2)),
    etaHoursMax: Number(etaHoursMax.toFixed(2)),
    reason: reasons.join("; "),
    volumeScore: Number(volumeScore.toFixed(1)),
    volumeOk,
    volumeRatio,
    adaptiveTakeProfitPct: useTp,
    adaptiveStopLossPct: useSl,
  };
}

export async function runMarketAnalysis(
  freeUsdtOverride?: number,
): Promise<MarketAnalysisResult> {
  const c = getConfig();
  const freeUsdt = freeUsdtOverride ?? (await getFreeUsdt());
  const plan = buildAdaptiveCandidatePlan(freeUsdt);
  const symbols = [...plan.analysisSymbols];
  if (!symbols.length) {
    symbols.push(...(c.candidateSymbols.length ? c.candidateSymbols : [c.symbol]));
    if (btcReferenceEnabled() && !symbols.includes(BTC_REFERENCE_SYMBOL)) {
      symbols.unshift(BTC_REFERENCE_SYMBOL);
    }
  }

  const candidates: SymbolOpportunity[] = [];
  for (const sym of symbols) {
    if (isBlacklisted(sym)) {
      pushLog("info", `analysis skip blacklist ${sym}`);
      continue;
    }
    try {
      candidates.push(await analyzeSymbol(sym, freeUsdt));
    } catch (e) {
      pushLog("warn", `analysis ${sym}: ${e instanceof Error ? e.message : e}`);
    }
  }

  candidates.sort(compareOpportunities);

  const news = newsContextEnabled() ? getCachedNews() ?? (await ensureNewsContext()) : null;
  let regime = marketRegimeEnabled() ? getCachedRegime() : null;
  const preBest = candidates[0] ?? null;
  if (marketRegimeEnabled() && !regime) {
    await detectMarketRegime({
      at: new Date().toISOString(),
      freeUsdt,
      activeSymbol: getTradingSymbol(),
      takeProfitPct: c.takeProfitPct > 0 ? c.takeProfitPct : 3.5,
      stopLossPct: c.stopLossPct > 0 ? c.stopLossPct : 1.5,
      candidates,
      best: preBest,
    });
    regime = getCachedRegime();
  }
  enrichCandidatesWithMacro(candidates, news, regime);
  candidates.sort(compareOpportunities);

  const btcContext = btcReferenceEnabled()
    ? await buildBtcMarketContext(freeUsdt)
    : null;

  const tradableSet = new Set(plan.tradableSymbols);
  const tradable = candidates.filter((x) => tradableSet.has(x.symbol));
  const pool = tradable.length ? tradable : candidates.filter(
    (x) => x.symbol !== BTC_REFERENCE_SYMBOL || plan.btcTradable,
  );

  const best =
    pool.find(
      (x) =>
        x.affordable &&
        x.buyScore >= stagnantMinScore() &&
        (x.signal === "buy" || x.signal === "strong_buy"),
    ) ||
    pool.find((x) => x.affordable && x.buyScore >= 30) ||
    pool.find((x) => x.affordable) ||
    pool[0] ||
    null;

  return {
    at: new Date().toISOString(),
    freeUsdt,
    activeSymbol: getTradingSymbol(),
    takeProfitPct: c.takeProfitPct > 0 ? c.takeProfitPct : 3.5,
    stopLossPct: c.stopLossPct > 0 ? c.stopLossPct : 1.5,
    candidates,
    best,
    btcContext,
    candidatePlan: plan,
  };
}

let lastAnalysisAt = 0;

/** Reescanea y cambia el par activo si hay mejor oportunidad asequible. */
export async function maybeRotateSymbol(): Promise<MarketAnalysisResult | null> {
  const c = getConfig();
  if (!c.capitalMode || !c.autoPickSymbol) return null;
  if (hasOpenPosition()) return null;
  const now = Date.now();
  if (now - lastAnalysisAt < c.analysisIntervalMs) return null;
  lastAnalysisAt = now;

  const analysis = await runMarketAnalysis();
  const best = analysis.best;
  if (!best?.affordable) return analysis;

  const current = getTradingSymbol();
  const currentRow = analysis.candidates.find((x) => x.symbol === current);
  const shouldSwitch =
    !currentRow?.affordable ||
    (best.symbol !== current &&
      best.buyScore >= (currentRow?.buyScore ?? 0) + c.symbolSwitchScoreDelta);

  if (shouldSwitch && best.symbol !== current) {
    setTradingSymbol(best.symbol);
    pushLog(
      "info",
      `capital: par activo ${current} → ${best.symbol} score=${best.buyScore} TP~${best.projectedProfitUsdt} USDT`,
    );
  }
  return analysis;
}

let lastAnalysisCache: MarketAnalysisResult | null = null;

export function setLastAnalysis(a: MarketAnalysisResult): void {
  lastAnalysisCache = a;
}

export function getLastAnalysis(): MarketAnalysisResult | null {
  return lastAnalysisCache;
}
