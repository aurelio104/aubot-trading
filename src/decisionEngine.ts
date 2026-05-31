import { getConfig } from "./config.js";
import { getFreeUsdt } from "./capital.js";
import { hasOpenPosition, getPosition } from "./position.js";
import {
  getLastAnalysis,
  runMarketAnalysis,
} from "./marketAnalysis.js";
import {
  effectiveEnterMinScore,
  isBlockedHourUtc,
  isCircuitOpen,
  circuitOpenReason,
  stagnantMinScore,
  preserveModeActive,
} from "./runtimeConfig.js";
import { getCachedRegime, detectMarketRegime, marketRegimeEnabled } from "./marketRegime.js";
import {
  ensureNewsContext,
  getCachedNews,
  newsBlocksEntry,
  newsGateReason,
  newsMinScoreBoost,
} from "./newsContext.js";
import { getActiveMacroWindow } from "./macroCalendar.js";
import { checkMtfAlignment } from "./multiTimeframe.js";
import {
  firstWinMinScoreBoost,
  firstWinRequireStrongBuy,
} from "./firstWinMode.js";
import {
  minNetEdgeUsdt,
  netProjectedProfitUsdt,
} from "./capitalRules.js";
import { canOpenNewTrade, getDayStats, getRiskBlockReason, isRiskBlocked, canOpenNewTradeAsync } from "./risk.js";
import { getTradingSymbol } from "./tradingSymbol.js";

export interface DecisionSnapshot {
  at: string;
  action: "HOLD_POSITION" | "WAIT" | "ENTER_CANDIDATE" | "BLOCKED";
  symbol: string;
  price: number;
  freeUsdt: number;
  reasons: string[];
  gates: Record<string, boolean | string | number>;
  technical: Record<string, unknown> | null;
  regime: Record<string, unknown> | null;
  news: Record<string, unknown> | null;
  macro: Record<string, unknown> | null;
  summaryEs: string;
}

export async function evaluateDecision(): Promise<DecisionSnapshot> {
  const c = getConfig();
  const free = await getFreeUsdt();
  const reasons: string[] = [];
  const gates: Record<string, boolean | string | number> = {};

  if (hasOpenPosition()) {
    const pos = getPosition()!;
    const sym = getTradingSymbol();
    return {
      at: new Date().toISOString(),
      action: "HOLD_POSITION",
      symbol: sym,
      price: pos.entryPrice,
      freeUsdt: free,
      reasons: ["posición LONG abierta — gestionar TP/SL/trailing"],
      gates: { hasPosition: true },
      technical: null,
      regime: marketRegimeEnabled() ? (getCachedRegime() as unknown as Record<string, unknown>) : null,
      news: getCachedNews() as unknown as Record<string, unknown> | null,
      macro: null,
      summaryEs: `Mantener posición ${sym} qty=${pos.quantity}`,
    };
  }

  const macro = getActiveMacroWindow();
  gates.macroActive = macro.active;
  if (macro.active) {
    reasons.push(macro.reason);
  }

  gates.circuitOpen = isCircuitOpen();
  if (isCircuitOpen()) reasons.push(circuitOpenReason());

  gates.riskBlocked = isRiskBlocked();
  if (isRiskBlocked()) reasons.push(getRiskBlockReason() || "risk blocked");

  gates.blockedHour = isBlockedHourUtc();
  if (isBlockedHourUtc()) reasons.push("hora UTC bloqueada (aprendizaje)");

  gates.canOpen = await canOpenNewTradeAsync();
  if (!gates.canOpen) reasons.push(getRiskBlockReason() || "canOpenNewTrade=false");

  const news = await ensureNewsContext();
  gates.newsBlock = news?.blockAllEntries ?? false;
  gates.newsScoreBoost = newsMinScoreBoost(news);
  if (news?.blockAllEntries) reasons.push(news.gateReason || "noticias bloquean entradas");
  if ((news?.minScoreBoost ?? 0) > 0) {
    reasons.push(`noticias +${news?.minScoreBoost} umbral score`);
  }

  let regime = marketRegimeEnabled() ? getCachedRegime() : null;
  const analysis = getLastAnalysis() ?? (await runMarketAnalysis(free));
  if (marketRegimeEnabled() && !regime) {
    regime = await detectMarketRegime(analysis);
  }

  const best = analysis.best;
  const stagnant = stagnantMinScore();
  const minScore =
    Math.max(
      effectiveEnterMinScore(),
      regime?.minEnterScore ?? effectiveEnterMinScore(),
      preserveModeActive(free) ? 70 : 0,
    ) +
    Math.max(0, newsMinScoreBoost(news)) +
    firstWinMinScoreBoost();

  gates.minScoreRequired = minScore;
  gates.stagnantThreshold = stagnant;

  let action: DecisionSnapshot["action"] = "WAIT";
  let technical: Record<string, unknown> | null = null;

  if (!best?.affordable) {
    reasons.push("sin par asequible");
    action = "BLOCKED";
  } else {
    const mtf = await checkMtfAlignment(best.symbol);
    gates.mtfAligned = mtf.aligned;
    gates.mtfPenalty = mtf.penalty;
    if (!mtf.aligned) reasons.push(mtf.reason);

    const effectiveMin = minScore + (mtf.aligned ? mtf.penalty : 0);
    gates.effectiveMinScore = effectiveMin;

    const strong = analysis.candidates.filter(
      (x) =>
        x.affordable &&
        x.buyScore >= stagnant &&
        (x.signal === "buy" || x.signal === "strong_buy"),
    );
    if (strong.length === 0) {
      reasons.push(`mercado estancado — ningún par score≥${stagnant} buy/strong_buy`);
    }

    const netEdge = netProjectedProfitUsdt(
      best.projectedProfitUsdt,
      best.quoteUsdt,
    );
    gates.netEdgeUsdt = netEdge;
    gates.minNetEdge = minNetEdgeUsdt();
    if (netEdge < minNetEdgeUsdt()) {
      reasons.push(`edge neto ${netEdge.toFixed(3)} < ${minNetEdgeUsdt()} USDT (fees)`);
    }
    if (firstWinRequireStrongBuy() && best.signal !== "strong_buy") {
      reasons.push("modo primera ganancia: solo strong_buy hasta 1er cierre positivo");
    }

    technical = {
      symbol: best.symbol,
      buyScore: best.buyScore,
      signal: best.signal,
      rsi: best.rsi,
      projectedProfitUsdt: best.projectedProfitUsdt,
      netEdgeUsdt: netEdge,
      mtf: mtf,
    };

    if (newsBlocksEntry(best.symbol, news)) {
      reasons.push(newsGateReason(best.symbol, news) || "par bloqueado por noticias");
      action = "BLOCKED";
    } else if (
      macro.active ||
      isCircuitOpen() ||
      isRiskBlocked() ||
      !gates.canOpen ||
      isBlockedHourUtc() ||
      strong.length === 0 ||
      best.buyScore < effectiveMin ||
      (best.signal !== "buy" && best.signal !== "strong_buy") ||
      (firstWinRequireStrongBuy() && best.signal !== "strong_buy") ||
      !mtf.aligned ||
      netEdge < minNetEdgeUsdt()
    ) {
      action = reasons.some((r) => /bloque|macro|circuit|risk|noticias bloquean/i.test(r))
        ? "BLOCKED"
        : "WAIT";
    } else {
      action = "ENTER_CANDIDATE";
      reasons.push(
        `candidato ${best.symbol} score=${best.buyScore} net~${netEdge.toFixed(3)} USDT`,
      );
    }
  }

  const summary =
    action === "ENTER_CANDIDATE"
      ? `Operaría ${best?.symbol} si autoTrade confirma`
      : action === "BLOCKED"
        ? `Bloqueado: ${reasons[0] || "gates"}`
        : `Esperar: ${reasons.slice(0, 2).join("; ") || "sin señal fuerte"}`;

  return {
    at: new Date().toISOString(),
    action,
    symbol: best?.symbol ?? getTradingSymbol(),
    price: best?.price ?? 0,
    freeUsdt: free,
    reasons,
    gates,
    technical,
    regime: regime as unknown as Record<string, unknown> | null,
    news: news as unknown as Record<string, unknown> | null,
    macro: { active: macro.active, reason: macro.reason, event: macro.event },
    summaryEs: summary,
  };
}
