import { getConfig } from "./config.js";
import { getFreeUsdt } from "./capital.js";
import { getPosition, hasOpenPosition } from "./position.js";
import {
  runMarketAnalysis,
  setLastAnalysis,
  type SymbolOpportunity,
} from "./marketAnalysis.js";
import { getTradingSymbol, setTradingSymbol } from "./tradingSymbol.js";
import { pushLog } from "./log.js";
import { cooldownReady, executeBuy, executeSell } from "./risk.js";
import { rotateMinEdgeUsdt } from "./runtimeConfig.js";
import {
  netPnlPct,
  netPnlUsdt,
  projectedNetProfitUsdt,
  rotateSwapFeeBufferUsdt,
} from "./capitalRules.js";

let lastRotateCheckAt = 0;
let lastRotateAt = 0;

export function rotateOnBetterEnabled(): boolean {
  return process.env.AUBOT_ROTATE_ON_BETTER !== "false";
}

function minLossPct(): number {
  return Math.max(0.05, Number(process.env.AUBOT_ROTATE_MIN_LOSS_PCT || "0.25") || 0.25);
}

function minScore(): number {
  return Math.max(60, Number(process.env.AUBOT_ROTATE_MIN_SCORE || "75") || 75);
}

function scoreDelta(): number {
  return Math.max(3, Number(process.env.AUBOT_ROTATE_SCORE_DELTA || "8") || 8);
}

function checkIntervalMs(): number {
  return Math.max(60_000, Number(process.env.AUBOT_ROTATE_CHECK_MS || "120_000") || 120_000);
}

function rotateCooldownMs(): number {
  return Math.max(60_000, Number(process.env.AUBOT_ROTATE_COOLDOWN_MS || "180_000") || 180_000);
}

function isStableOpportunity(opp: SymbolOpportunity): boolean {
  return (
    opp.signal === "strong_buy" &&
    opp.buyScore >= minScore() &&
    opp.affordable
  );
}

function rotateNetEdgeUsdt(
  best: SymbolOpportunity,
  currentNetUsdt: number,
  posQuoteUsdt: number,
): number {
  const recovery = Math.abs(Math.min(0, currentNetUsdt));
  const feeBuf = rotateSwapFeeBufferUsdt(posQuoteUsdt);
  return (
    projectedNetProfitUsdt(best) -
    recovery -
    feeBuf -
    rotateMinEdgeUsdt()
  );
}

function isBetterThanCurrent(
  best: SymbolOpportunity,
  current: SymbolOpportunity | undefined,
  currentNetUsdt: number,
  currentNetPct: number,
  posQuoteUsdt: number,
): { ok: boolean; reason: string } {
  if (best.symbol === current?.symbol) {
    return { ok: false, reason: "mismo par" };
  }
  if (!isStableOpportunity(best)) {
    return { ok: false, reason: "mejor candidato no cumple strong_buy/score/affordable" };
  }
  if (currentNetUsdt >= 0) {
    return { ok: false, reason: "posición no está en pérdida neta (tras fees)" };
  }
  if (currentNetPct > -minLossPct()) {
    return {
      ok: false,
      reason: `pérdida neta ${currentNetPct.toFixed(2)}% < umbral ${minLossPct()}%`,
    };
  }

  const edge = rotateNetEdgeUsdt(best, currentNetUsdt, posQuoteUsdt);
  if (edge < 0) {
    return {
      ok: false,
      reason: `edge neto rotación ${edge.toFixed(3)} USDT < 0 (fees swap incluidos)`,
    };
  }

  const curScore = current?.buyScore ?? 0;
  const curSignal = current?.signal ?? "hold";
  const scoreBetter = best.buyScore >= curScore + scoreDelta();
  const currentWeakened = curSignal !== "strong_buy";
  const fasterEta =
    !!current &&
    best.etaHoursMax > 0 &&
    current.etaHoursMax > 0 &&
    best.etaHoursMax <= current.etaHoursMax * 0.85;
  const higherProfit =
    projectedNetProfitUsdt(best) >
    projectedNetProfitUsdt({
      projectedProfitUsdt: current?.projectedProfitUsdt ?? 0,
      netProfitUsdt: current?.netProfitUsdt,
      quoteUsdt: current?.quoteUsdt ?? 0,
    }) *
      1.05;

  if (scoreBetter) {
    return {
      ok: true,
      reason: `score ${best.buyScore} vs ${curScore} (Δ≥${scoreDelta()}) edge neto ${edge.toFixed(3)} USDT`,
    };
  }
  if (currentWeakened && best.buyScore >= curScore) {
    return {
      ok: true,
      reason: `${current?.symbol} ya no strong_buy; ${best.symbol} edge neto ${edge.toFixed(3)} USDT`,
    };
  }
  if (fasterEta && higherProfit && best.buyScore >= curScore) {
    return {
      ok: true,
      reason: `ETA más rápida + mejor proyección neta; edge ${edge.toFixed(3)} USDT`,
    };
  }
  return { ok: false, reason: "ningún criterio de mejora estable cumplido" };
}

export interface RotationAnalysis {
  at: string;
  currentSymbol: string;
  currentPnlPct: number;
  currentNetPnlUsdt: number;
  currentScore: number;
  currentSignal: string;
  best: SymbolOpportunity | null;
  shouldRotate: boolean;
  reason: string;
}

export async function analyzeRotation(price: number): Promise<RotationAnalysis> {
  const symbol = getTradingSymbol();
  const pos = getPosition();
  const grossPct = pos ? ((price / pos.entryPrice - 1) * 100) : 0;
  const netUsdt = pos
    ? netPnlUsdt(pos.entryPrice, price, pos.quantity)
    : 0;
  const netPct = pos
    ? netPnlPct(pos.entryPrice, price)
    : 0;
  const posQuote = pos ? pos.entryPrice * pos.quantity : 0;
  const free = await getFreeUsdt();
  const totalUsdt = free + (pos ? pos.quantity * price : 0);
  const analysis = await runMarketAnalysis(totalUsdt);
  setLastAnalysis(analysis);

  const current = analysis.candidates.find((x) => x.symbol === symbol);
  const best = analysis.best;
  let shouldRotate = false;
  let reason = "sin acción";

  if (best && current) {
    const cmp = isBetterThanCurrent(best, current, netUsdt, netPct, posQuote);
    shouldRotate = cmp.ok;
    reason = cmp.reason;
  } else if (!best) {
    reason = "sin candidato affordable";
  }

  return {
    at: new Date().toISOString(),
    currentSymbol: symbol,
    currentPnlPct: Number(grossPct.toFixed(3)),
    currentNetPnlUsdt: Number(netUsdt.toFixed(4)),
    currentScore: current?.buyScore ?? 0,
    currentSignal: current?.signal ?? "—",
    best,
    shouldRotate,
    reason,
  };
}

/** Cierra posición en pérdida y reentra en mejor oportunidad estable si conviene. */
export async function maybeRotateOnBetterOpportunity(
  price: number,
  force = false,
): Promise<boolean> {
  const c = getConfig();
  if (!c.autoTrade || !rotateOnBetterEnabled() || !c.capitalMode) return false;
  if (!hasOpenPosition()) return false;

  const now = Date.now();
  if (!force) {
    if (now - lastRotateCheckAt < checkIntervalMs()) return false;
    if (now - lastRotateAt < rotateCooldownMs()) return false;
  }
  lastRotateCheckAt = now;

  if (!cooldownReady() && !force) return false;

  const symbol = getTradingSymbol();
  const pos = getPosition()!;
  const netUsdt = netPnlUsdt(pos.entryPrice, price, pos.quantity);
  const netPct = netPnlPct(pos.entryPrice, price);
  const analysis = await analyzeRotation(price);
  const best = analysis.best;

  if (!analysis.shouldRotate || !best) {
    if (netPct < -minLossPct()) {
      pushLog(
        "info",
        `rotate-check ${symbol} net=${netUsdt.toFixed(4)} USDT (${netPct.toFixed(2)}%) — hold: ${analysis.reason}`,
      );
    }
    return false;
  }

  const qty = String(pos.quantity);
  pushLog(
    "info",
    `rotate: cerrar ${symbol} net=${netUsdt.toFixed(4)} USDT → ${best.symbol} score=${best.buyScore} (${analysis.reason})`,
  );

  const sold = await executeSell(
    symbol,
    qty,
    price,
    `rotate-on-better ${analysis.reason}`,
  );
  if (!sold) return false;

  lastRotateAt = Date.now();
  setTradingSymbol(best.symbol);
  const bought = await executeBuy(
    best.symbol,
    c.tradeQty,
    best.price,
    `rotate-entry score=${best.buyScore} ${best.reason}`,
  );
  return bought;
}
