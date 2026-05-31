import { getConfig } from "./config.js";
import { binanceBaseUrl, createMarketOrder } from "./binance.js";
import { createSmartMarketBuy, resolveTradeQuantity } from "./capital.js";
import { formatQtyString, getSymbolFilters } from "./exchangeInfo.js";
import { getTradingSymbol } from "./tradingSymbol.js";
import {
  consolidateEnabled,
  consolidateToUsdt,
} from "./consolidateUsdt.js";
import {
  earnProtectionEnabled,
  ensureSpotNotEarn,
} from "./simpleEarn.js";
import { syncPositionFromBalances } from "./syncPosition.js";
import {
  isCircuitOpen,
  circuitOpenReason,
  recordStopLoss,
  paperTradeEnabled,
  minSpotUsdt,
  preserveModeActive,
  isBlockedHourUtc,
} from "./runtimeConfig.js";
import {
  maxWeeklyLossUsdt,
  smallCapitalBelowUsdt,
  smallCapitalMaxTradesDay,
  roundTripFeePct,
  minGrossTpPct,
  feeAwareExitsEnabled,
  netPnlUsdt,
} from "./capitalRules.js";
import { getFreeUsdt } from "./capital.js";
import { logDecision, logOrderAudit } from "./journal.js";
import {
  recordBuyFill,
  recordSellClose,
  recordSellClosePaper,
} from "./tradeLedger.js";
import { firstWinMaxTradesDay } from "./firstWinMode.js";
import { getLastAnalysis } from "./marketAnalysis.js";
import {
  closePosition,
  getPosition,
  hasOpenPosition,
  openLong,
  addToLong,
  updateHighest,
} from "./position.js";
import { pushLog } from "./log.js";
import {
  ensureNewsContext,
  newsBlocksEntry,
  newsGateReason,
} from "./newsContext.js";

interface DayStats {
  date: string;
  tradeCount: number;
  realizedPnlUsdt: number;
}

interface WeekStats {
  weekId: string;
  realizedPnlUsdt: number;
}

let stats: DayStats = freshDay();
let weekStats: WeekStats = freshWeek();
let lastActionAt = 0;
let blocked = false;
let blockReason = "";
let sellFailStreak = 0;

function sellFailRedeemAt(): number {
  return Math.max(2, Number(process.env.AUBOT_SELL_FAIL_REDEEM_AT || "3") || 3);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function freshDay(): DayStats {
  return { date: today(), tradeCount: 0, realizedPnlUsdt: 0 };
}

function freshWeek(): WeekStats {
  return { weekId: isoWeekId(), realizedPnlUsdt: 0 };
}

function isoWeekId(d = new Date()): string {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = x.getUTCDay() || 7;
  x.setUTCDate(x.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((x.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${x.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function rollWeekIfNeeded(): void {
  const id = isoWeekId();
  if (weekStats.weekId !== id) weekStats = freshWeek();
}

function rollDayIfNeeded(): void {
  if (stats.date !== today()) {
    stats = freshDay();
    blocked = false;
    blockReason = "";
  }
  rollWeekIfNeeded();
}

export function isRiskBlocked(): boolean {
  rollDayIfNeeded();
  return blocked;
}

export function getRiskBlockReason(): string {
  return blockReason;
}

export function getDayStats(): DayStats {
  rollDayIfNeeded();
  return { ...stats };
}

export function getWeekStats(): WeekStats {
  rollWeekIfNeeded();
  return { ...weekStats };
}

export function canOpenNewTrade(): boolean {
  rollDayIfNeeded();
  if (blocked) return false;
  if (isCircuitOpen()) {
    blocked = true;
    blockReason = circuitOpenReason();
    return false;
  }
  const c = getConfig();
  if (c.maxTradesPerDay > 0 && stats.tradeCount >= c.maxTradesPerDay) {
    blocked = true;
    blockReason = `max trades/day (${c.maxTradesPerDay})`;
    pushLog("warn", `risk: ${blockReason}`);
    return false;
  }
  if (c.maxDailyLossUsdt > 0 && stats.realizedPnlUsdt <= -c.maxDailyLossUsdt) {
    blocked = true;
    blockReason = `max daily loss (${c.maxDailyLossUsdt} USDT)`;
    pushLog("warn", `risk: ${blockReason}`);
    return false;
  }
  const maxWeek = maxWeeklyLossUsdt();
  if (maxWeek > 0 && weekStats.realizedPnlUsdt <= -maxWeek) {
    blocked = true;
    blockReason = `max weekly loss (${maxWeek} USDT)`;
    pushLog("warn", `risk: ${blockReason}`);
    return false;
  }
  return true;
}

export async function canOpenNewTradeAsync(): Promise<boolean> {
  rollDayIfNeeded();
  if (!canOpenNewTrade()) return false;
  const c = getConfig();
  if (!c.capitalMode) return true;
  const free = await getFreeUsdt();
  if (free > 0 && free < smallCapitalBelowUsdt()) {
    const maxDay = firstWinMaxTradesDay();
    if (stats.tradeCount >= maxDay) {
      blocked = true;
      blockReason = `small capital max ${maxDay} trades/day`;
      pushLog("warn", `risk: ${blockReason}`);
      return false;
    }
  }
  return true;
}

export function cooldownReady(): boolean {
  const c = getConfig();
  return Date.now() - lastActionAt >= c.cooldownMs;
}

export function markTrade(): void {
  rollDayIfNeeded();
  stats.tradeCount += 1;
  lastActionAt = Date.now();
}

export function recordRealizedPnl(pnlUsdt: number): void {
  rollDayIfNeeded();
  stats.realizedPnlUsdt += pnlUsdt;
  weekStats.realizedPnlUsdt += pnlUsdt;
  if (getConfig().maxDailyLossUsdt > 0) {
    if (stats.realizedPnlUsdt <= -getConfig().maxDailyLossUsdt) {
      blocked = true;
      blockReason = `max daily loss reached (${stats.realizedPnlUsdt.toFixed(2)} USDT)`;
      pushLog("warn", `risk: ${blockReason}`);
    }
  }
}

export async function executeBuy(
  symbol: string,
  quantity: string,
  price: number,
  reason: string,
): Promise<boolean> {
  if (!(await canOpenNewTradeAsync()) || !cooldownReady()) return false;
  const c = getConfig();

  const free = await getFreeUsdt();
  if (free < minSpotUsdt()) {
    pushLog("warn", `risk: skip BUY freeUsdt ${free} < min ${minSpotUsdt()}`);
    return false;
  }
  if (preserveModeActive(free)) {
    pushLog("info", "preserve mode: capital bajo — entrada más selectiva");
  }
  if (isBlockedHourUtc()) {
    pushLog("warn", "risk: skip BUY — hora UTC bloqueada por aprendizaje");
    return false;
  }

  const news = await ensureNewsContext();
  if (newsBlocksEntry(symbol, news)) {
    pushLog(
      "warn",
      `risk: news gate skip BUY ${symbol} — ${newsGateReason(symbol, news) || news?.gateReason || "bloqueado"}`,
    );
    return false;
  }

  const resolved = await resolveTradeQuantity(symbol, price);
  if (!resolved) return false;
  const { quantity: qty, quoteUsdt } = resolved;
  const notional = quoteUsdt;

  if (c.maxPositionUsdt > 0 && notional > c.maxPositionUsdt) {
    pushLog("warn", `risk: skip BUY notional ${notional} > max ${c.maxPositionUsdt}`);
    return false;
  }
  pushLog(
    "info",
    `trade BUY ${symbol} qty=${qty} ~${notional.toFixed(2)} USDT @${price} — ${reason}`,
  );
  if (paperTradeEnabled()) {
    pushLog("info", `paper BUY ${symbol} (simulado)`);
  } else {
    const order = (await createSmartMarketBuy(symbol, qty, notional)) as {
      orderId: number;
      executedQty?: string;
      cummulativeQuoteQty?: string;
    };
    const filledQty = Number(order.executedQty || qty);
    const fillPrice =
      filledQty > 0 && order.cummulativeQuoteQty
        ? Number(order.cummulativeQuoteQty) / filledQty
        : price;

    if (c.strategy === "dca" && hasOpenPosition()) {
      addToLong(fillPrice, filledQty);
    } else {
      openLong(fillPrice, filledQty);
    }
    const analysis = getLastAnalysis();
    const row = analysis?.candidates.find((x) => x.symbol === symbol);
    recordBuyFill(symbol, order, fillPrice, filledQty, {
      reason,
      score: row?.buyScore,
      rsi: row?.rsi,
      signal: row?.signal,
    });
    logDecision({
      at: new Date().toISOString(),
      side: "BUY",
      symbol,
      price: fillPrice,
      quantity: filledQty,
      reason,
      score: row?.buyScore,
      rsi: row?.rsi,
      signal: row?.signal,
    });
    logOrderAudit({
      at: new Date().toISOString(),
      symbol,
      side: "BUY",
      qty: String(filledQty),
      price: fillPrice,
      reason,
    });
    markTrade();
    return true;
  }

  if (c.strategy === "dca" && hasOpenPosition()) {
    addToLong(price, Number(qty));
  } else {
    openLong(price, Number(qty));
  }
  logDecision({
    at: new Date().toISOString(),
    side: "BUY",
    symbol,
    price,
    quantity: Number(qty),
    reason: `${reason} (paper)`,
  });
  markTrade();
  return true;
}

async function formatSellQty(symbol: string, quantity: string): Promise<string> {
  const filters = await getSymbolFilters(symbol, binanceBaseUrl());
  return formatQtyString(Number(quantity), filters.stepSize);
}

export async function executeSell(
  symbol: string,
  quantity: string,
  price: number,
  reason: string,
): Promise<boolean> {
  if (!cooldownReady()) return false;
  const base = symbol.replace(/USDT$/i, "");
  if (earnProtectionEnabled()) {
    await ensureSpotNotEarn([base]).catch((e) => {
      pushLog(
        "warn",
        `earn before sell: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }
  const qty = await formatSellQty(symbol, quantity);
  if (Number(qty) <= 0) {
    pushLog("warn", `trade SELL skip qty=0 (${symbol})`);
    return false;
  }
  pushLog("info", `trade SELL ${symbol} qty=${qty} @${price} — ${reason}`);
  const posBefore = getPosition();
  let sellOrder: { orderId: number; executedQty?: string; cummulativeQuoteQty?: string } | null =
    null;
  if (!paperTradeEnabled()) {
    try {
      sellOrder = (await createMarketOrder(symbol, "SELL", qty)) as {
        orderId: number;
        executedQty?: string;
        cummulativeQuoteQty?: string;
      };
    } catch (e) {
    sellFailStreak += 1;
    const msg = e instanceof Error ? e.message : String(e);
    pushLog(
      "error",
      `sell_fail streak=${sellFailStreak} ${symbol}: ${msg}`,
    );
    if (sellFailStreak >= sellFailRedeemAt()) {
      pushLog("warn", `sell_fail recovery: redeem + consolidate + sync ${symbol}`);
      if (earnProtectionEnabled()) {
        await ensureSpotNotEarn([base]).catch(() => undefined);
      }
      if (consolidateEnabled()) {
        await consolidateToUsdt().catch(() => undefined);
      }
      const synced = await syncPositionFromBalances(symbol);
      if (!synced.synced) {
        closePosition();
        pushLog("info", `sell_fail recovery: position cleared (Spot empty)`);
      }
      sellFailStreak = 0;
    }
      return false;
    }
  } else {
    pushLog("info", `paper SELL ${symbol} (simulado)`);
  }
  sellFailStreak = 0;
  const pos = posBefore ?? getPosition();
  if (pos) {
    let closed = null;
    if (sellOrder) {
      const soldQty = Number(sellOrder.executedQty || qty);
      closed = await recordSellClose(
        symbol,
        sellOrder,
        price,
        soldQty,
        reason,
        {
          entryPrice: pos.entryPrice,
          quantity: pos.quantity,
          openedAt: pos.openedAt,
        },
      );
    } else if (paperTradeEnabled()) {
      closed = await recordSellClosePaper(symbol, price, reason, pos);
    }
    const pnl = closed?.pnlUsdt ?? (price - pos.entryPrice) * pos.quantity;
    const pnlPct =
      closed?.pnlPct ??
      (pos.entryPrice > 0 ? ((price / pos.entryPrice - 1) * 100) : 0);
    recordRealizedPnl(pnl);
    pushLog(
      "info",
      `pnl ${closed ? "exact" : "estimate"} ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} USDT fees=${closed?.feesUsdt?.toFixed(4) ?? "?"}`,
    );
    if (/stop-loss/i.test(reason)) recordStopLoss();
    logDecision({
      at: new Date().toISOString(),
      side: "SELL",
      symbol,
      price,
      quantity: pos.quantity,
      reason,
      pnlUsdt: pnl,
      pnlPct,
    });
    logOrderAudit({
      at: new Date().toISOString(),
      symbol,
      side: "SELL",
      qty,
      price,
      reason,
    });
  }
  closePosition();
  markTrade();
  if (consolidateEnabled()) {
    await consolidateToUsdt().catch((e) => {
      pushLog(
        "warn",
        `consolidate after sell: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }
  return true;
}

/** TP/SL efectivos: adaptive del último análisis o config base. */
function resolveExitPercents(
  symbol: string,
  c: ReturnType<typeof getConfig>,
): { tpPct: number; slPct: number } {
  const analysis = getLastAnalysis();
  const row = analysis?.candidates.find((x) => x.symbol === symbol);
  const baseTp = c.takeProfitPct > 0 ? c.takeProfitPct : 3;
  const baseSl = c.stopLossPct > 0 ? c.stopLossPct : 2;
  if (row?.adaptiveTakeProfitPct && row.adaptiveStopLossPct) {
    return { tpPct: row.adaptiveTakeProfitPct, slPct: row.adaptiveStopLossPct };
  }
  return { tpPct: baseTp, slPct: baseSl };
}

/** Stop-loss, take-profit, trailing, break-even, time exit */
export async function runRiskExits(price: number): Promise<void> {
  if (!hasOpenPosition()) return;
  updateHighest(price);
  const pos = getPosition()!;
  const c = getConfig();
  const symbol = getTradingSymbol();
  const qty = await formatSellQty(symbol, String(pos.quantity));
  const { tpPct: exitTpPct, slPct: exitSlPct } = resolveExitPercents(symbol, c);

  const pnlPct =
    pos.entryPrice > 0 ? ((price / pos.entryPrice - 1) * 100) : 0;
  const feeCoverPct = feeAwareExitsEnabled() ? minGrossTpPct() : 0;
  const breakEvenPct = Math.max(
    Number(process.env.AUBOT_BREAK_EVEN_PCT || "1.5") || 1.5,
    feeCoverPct,
  );
  const timeExitH =
    Number(process.env.AUBOT_TIME_EXIT_HOURS || "48") || 48;
  const openedMs = pos.openedAt ? new Date(pos.openedAt).getTime() : 0;
  const ageH =
    openedMs > 0 ? (Date.now() - openedMs) / 3600_000 : 0;

  if (timeExitH > 0 && ageH >= timeExitH && pnlPct < exitTpPct * 0.5) {
    await executeSell(
      symbol,
      qty,
      price,
      `time-exit ${ageH.toFixed(0)}h pnl=${pnlPct.toFixed(2)}%`,
    );
    return;
  }

  const effectiveSlPct = exitSlPct;
  let stopPrice = pos.entryPrice * (1 - effectiveSlPct / 100);
  if (pnlPct >= breakEvenPct) {
    const feeFloor = feeAwareExitsEnabled()
      ? pos.entryPrice * (1 + (roundTripFeePct() * 1.05) / 100)
      : pos.entryPrice * 1.0005;
    stopPrice = Math.max(stopPrice, feeFloor);
  }

  if (price <= stopPrice) {
    const label =
      pnlPct >= breakEvenPct ? `break-even/stop ${pnlPct.toFixed(2)}%` : `stop-loss ${effectiveSlPct}%`;
    await executeSell(symbol, qty, price, label);
    return;
  }

  if (exitTpPct > 0) {
    const effectiveTpPct = feeAwareExitsEnabled()
      ? Math.max(exitTpPct, feeCoverPct)
      : exitTpPct;
    const tp = pos.entryPrice * (1 + effectiveTpPct / 100);
    if (price >= tp) {
      const net = netPnlUsdt(pos.entryPrice, price, pos.quantity);
      await executeSell(
        symbol,
        qty,
        price,
        `take-profit ${effectiveTpPct}% (net~${net.toFixed(3)} USDT)`,
      );
      return;
    }
  }

  const trailPct =
    c.trailingStopPct > 0
      ? c.trailingStopPct
      : Number(process.env.AUBOT_TRAILING_AFTER_TP_PCT || "0") || 0;
  const trailActivatePct = Math.max(
    Number(process.env.AUBOT_TRAILING_ACTIVATE_PCT || "1") || 1,
    feeCoverPct,
  );
  if (
    trailPct > 0 &&
    pos.highestSinceEntry > pos.entryPrice &&
    pnlPct >= trailActivatePct
  ) {
    const trail = pos.highestSinceEntry * (1 - trailPct / 100);
    if (price <= trail) {
      const net = netPnlUsdt(pos.entryPrice, price, pos.quantity);
      if (!feeAwareExitsEnabled() || net >= 0) {
        await executeSell(
          symbol,
          qty,
          price,
          `trailing-stop ${trailPct}% (net~${net.toFixed(3)} USDT)`,
        );
      }
    }
  }
}
