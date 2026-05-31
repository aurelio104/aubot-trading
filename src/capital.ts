import {
  binanceBaseUrl,
  createMarketBuyQuote,
  createMarketOrder,
  getAccountBalances,
  qtyFromQuoteUsdt,
} from "./binance.js";
import { getConfig } from "./config.js";
import {
  floorQtyToStep,
  formatQtyString,
  getSymbolFilters,
} from "./exchangeInfo.js";
import { pushLog } from "./log.js";
import { getTradingSymbol } from "./tradingSymbol.js";

export async function getFreeUsdt(): Promise<number> {
  const balances = await getAccountBalances();
  const row = balances.find((b) => b.asset === "USDT");
  return row ? Number(row.free) : 0;
}

/** USDT a invertir en la siguiente compra (reserva + % capital). */
export function quoteUsdtForTrade(freeUsdt: number): number {
  const c = getConfig();
  const afterReserve = Math.max(0, freeUsdt - c.reserveUsdt);
  const pct = Math.min(100, Math.max(1, c.capitalPct)) / 100;
  let quote = afterReserve * pct;
  if (c.maxPositionUsdt > 0) quote = Math.min(quote, c.maxPositionUsdt);
  return quote;
}

export async function resolveTradeQuantity(
  symbol: string,
  price: number,
): Promise<{ quantity: string; quoteUsdt: number } | null> {
  const c = getConfig();
  if (!c.capitalMode) {
    const notional = price * Number(c.tradeQty);
    return { quantity: c.tradeQty, quoteUsdt: notional };
  }

  const free = await getFreeUsdt();
  const quote = quoteUsdtForTrade(free);
  const filters = await getSymbolFilters(symbol, binanceBaseUrl());
  if (quote < Math.max(c.minNotionalUsdt, filters.minNotional)) {
    pushLog(
      "warn",
      `capital: USDT insuficiente free=${free.toFixed(2)} quote=${quote.toFixed(2)} min=${filters.minNotional}`,
    );
    return null;
  }

  let qty = quote / price;
  qty = floorQtyToStep(qty, filters.stepSize);
  if (qty < filters.minQty) {
    pushLog("warn", `capital: qty ${qty} < minQty ${filters.minQty} (${symbol})`);
    return null;
  }
  const notional = qty * price;
  if (notional < filters.minNotional) {
    pushLog("warn", `capital: notional ${notional.toFixed(2)} < min ${filters.minNotional}`);
    return null;
  }

  return {
    quantity: formatQtyString(qty, filters.stepSize),
    quoteUsdt: notional,
  };
}

/** Compra market por cantidad o por quote USDT si capitalMode. */
export async function createSmartMarketBuy(
  symbol: string,
  quantity: string,
  quoteUsdt: number,
): Promise<unknown> {
  const c = getConfig();
  if (c.capitalMode && c.useQuoteOrderQty) {
    return createMarketBuyQuote(symbol, quoteUsdt.toFixed(2));
  }
  return createMarketOrder(symbol, "BUY", quantity);
}

export function qtyFromCapitalFallback(quoteUsdt: number, price: number): string {
  return qtyFromQuoteUsdt(quoteUsdt, price);
}

export interface CapitalSnapshot {
  freeUsdt: number;
  quoteNextTradeUsdt: number;
  symbol: string;
  affordable: boolean;
}

export async function getCapitalSnapshot(): Promise<CapitalSnapshot> {
  const free = await getFreeUsdt();
  const quote = quoteUsdtForTrade(free);
  const symbol = getTradingSymbol();
  const c = getConfig();
  let affordable = quote >= c.minNotionalUsdt;
  if (affordable && c.capitalMode) {
    try {
      const f = await getSymbolFilters(symbol, binanceBaseUrl());
      affordable = quote >= f.minNotional;
    } catch {
      affordable = false;
    }
  }
  return { freeUsdt: free, quoteNextTradeUsdt: quote, symbol, affordable };
}
