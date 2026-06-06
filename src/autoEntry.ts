import { fetchTickerPrice } from "./binance.js";
import { getConfig } from "./config.js";
import { hasOpenPosition } from "./position.js";
import {
  getLastAnalysis,
  runMarketAnalysis,
  setLastAnalysis,
} from "./marketAnalysis.js";
import { pushLog } from "./log.js";
import { cooldownReady, executeBuy, canOpenNewTradeAsync } from "./risk.js";
import { getTradingSymbol, setTradingSymbol } from "./tradingSymbol.js";
import {
  effectiveEnterMinScore,
  preserveModeActive,
  stagnantMinScore,
  isBlockedHourUtc,
} from "./runtimeConfig.js";
import { getFreeUsdt } from "./capital.js";
import {
  detectMarketRegime,
  marketRegimeEnabled,
  regimeMinEnterScore,
} from "./marketRegime.js";
import {
  ensureNewsContext,
  newsBlocksEntry,
  newsGateReason,
  newsMinScoreBoost,
} from "./newsContext.js";
import { checkMtfAlignment } from "./multiTimeframe.js";
import { getActiveMacroWindow } from "./macroCalendar.js";
import {
  minNetEdgeUsdtForQuote,
  netProjectedProfitUsdt,
} from "./capitalRules.js";
import { evaluateDecision } from "./decisionEngine.js";

let lastAutoEnterAt = 0;

export function autoEnterEnabled(): boolean {
  return process.env.AUBOT_AUTO_ENTER !== "false";
}

function decisionGateEnabled(): boolean {
  return process.env.AUBOT_DECISION_GATE !== "false";
}

function enterMinScore(): number {
  return effectiveEnterMinScore();
}

/** Sin posición: escanea mercado y compra si hay buy/strong_buy con score alto. */
export async function maybeAutoEnter(): Promise<boolean> {
  const c = getConfig();
  if (!c.autoTrade || !autoEnterEnabled() || !c.capitalMode) return false;
  if (hasOpenPosition()) return false;
  if (!cooldownReady()) return false;

  const interval = Math.max(60_000, c.analysisIntervalMs);
  const now = Date.now();
  if (now - lastAutoEnterAt < interval) return false;
  lastAutoEnterAt = now;

  // Un solo cerebro: evaluar /decision primero (marca alta confianza) y luego límites/día
  if (decisionGateEnabled()) {
    const decision = await evaluateDecision();
    if (!(await canOpenNewTradeAsync())) {
      pushLog("info", `auto-enter: límite riesgo/día — ${decision.summaryEs}`);
      return false;
    }
    if (decision.action !== "ENTER_CANDIDATE") {
      const why =
        decision.reasons.slice(0, 2).join("; ") || decision.summaryEs;
      pushLog("info", `auto-enter: ${decision.action} — ${why}`);
      return false;
    }
    const sym = decision.symbol;
    const score = Number(decision.technical?.buyScore ?? 0);
    if (getTradingSymbol() !== sym) setTradingSymbol(sym);
    const price = await fetchTickerPrice(sym);
    pushLog(
      "info",
      `auto-enter decision OK: ${sym} score=${score} — ${decision.summaryEs}`,
    );
    return executeBuy(
      sym,
      c.tradeQty,
      price,
      `auto-entry decision score=${score}`,
    );
  }

  if (isBlockedHourUtc()) {
    pushLog("info", "auto-enter: hora UTC bloqueada");
    return false;
  }
  if (!(await canOpenNewTradeAsync())) return false;

  const free = await getFreeUsdt();
  if (preserveModeActive(free) && free > 0) {
    const minSc = Math.max(enterMinScore(), 70);
    if (minSc > enterMinScore()) {
      pushLog("info", `preserve mode active free=${free} minScore=${minSc}`);
    }
  }

  const analysis = getLastAnalysis() ?? (await runMarketAnalysis());
  if (!getLastAnalysis()) setLastAnalysis(analysis);
  if (marketRegimeEnabled()) {
    await detectMarketRegime(analysis);
  }
  const news = await ensureNewsContext();
  const macro = getActiveMacroWindow();
  if (macro.active) {
    pushLog("info", `auto-enter: macro window — ${macro.reason}`);
    return false;
  }
  const best = analysis.best;
  if (!best?.affordable) return false;

  const strong = analysis.candidates.filter(
    (x) =>
      x.affordable &&
      x.buyScore >= stagnantMinScore() &&
      (x.signal === "buy" || x.signal === "strong_buy"),
  );
  if (strong.length === 0) {
    pushLog("info", "auto-enter: mercado estancado — sin score≥stagnant threshold");
    return false;
  }

  const mtf = await checkMtfAlignment(best.symbol);
  if (!mtf.aligned) {
    pushLog("warn", `auto-enter: MTF ${best.symbol} — ${mtf.reason}`);
    return false;
  }

  const newsBoost = newsMinScoreBoost(news);
  const minScore = (preserveModeActive(free)
    ? Math.max(regimeMinEnterScore(), 70)
    : Math.max(regimeMinEnterScore(), enterMinScore())) + Math.max(0, newsBoost) + mtf.penalty;
  if (best.buyScore < minScore) {
    if (newsBoost > 0) {
      pushLog(
        "info",
        `auto-enter: score ${best.buyScore} < ${minScore} (news +${newsBoost})`,
      );
    }
    return false;
  }
  if (best.signal !== "strong_buy" && best.signal !== "buy") return false;

  if (newsBlocksEntry(best.symbol, news)) {
    pushLog(
      "warn",
      `auto-enter: news gate ${best.symbol} — ${newsGateReason(best.symbol, news) || news?.gateReason || "bloqueado"}`,
    );
    return false;
  }

  const netEdge = netProjectedProfitUsdt(best.projectedProfitUsdt, best.quoteUsdt);
  const minEdge = minNetEdgeUsdtForQuote(best.quoteUsdt || 0);
  if (netEdge < minEdge) {
    pushLog(
      "info",
      `auto-enter: edge neto ${netEdge.toFixed(3)} < ${minEdge.toFixed(3)} USDT (fees)`,
    );
    return false;
  }

  if (getTradingSymbol() !== best.symbol) {
    setTradingSymbol(best.symbol);
  }
  const price = await fetchTickerPrice(best.symbol);
  pushLog(
    "info",
    `auto-enter scan: ${best.symbol} score=${best.buyScore} signal=${best.signal}`,
  );
  return executeBuy(
    best.symbol,
    c.tradeQty,
    price,
    `auto-entry score=${best.buyScore} ${best.reason}`,
  );
}
