import { fetchKlines } from "../binance.js";
import { getConfig } from "../config.js";
import { getTradingSymbol } from "../tradingSymbol.js";
import { bollinger, rsi, toSeries } from "../indicators.js";
import { hasOpenPosition, getPosition } from "../position.js";
import { executeBuy, executeSell } from "../risk.js";
import { pushLog } from "../log.js";

let lastProcessedOpenTime = 0;

export async function runMeanReversion(price: number): Promise<void> {
  const c = getConfig();
  const symbol = getTradingSymbol();
  const klines = await fetchKlines(symbol, c.klineInterval, 120);
  if (klines.length < c.bbPeriod + 5) {
    pushLog("warn", "mean_reversion: insufficient klines");
    return;
  }

  // Última vela cerrada = penúltima (la última puede estar en formación)
  const closed = klines.slice(0, -1);
  const last = closed[closed.length - 1];
  if (!last || last.openTime === lastProcessedOpenTime) return;
  lastProcessedOpenTime = last.openTime;

  const series = toSeries(closed);
  const rsiValues = rsi(series.closes, c.rsiPeriod);
  const bb = bollinger(series.closes, c.bbPeriod, c.bbStdDev);
  const i = closed.length - 1;
  const r = rsiValues[i];
  const close = series.closes[i];
  const lower = bb.lower[i];
  const upper = bb.upper[i];

  if (Number.isNaN(r) || Number.isNaN(lower)) return;

  pushLog(
    "info",
    `mean_reversion candle ${c.klineInterval} RSI=${r.toFixed(1)} close=${close}`,
  );

  if (
    !hasOpenPosition() &&
    r < c.rsiBuyBelow &&
    close < lower
  ) {
    await executeBuy(
      symbol,
      c.tradeQty,
      price,
      `RSI ${r.toFixed(1)} < ${c.rsiBuyBelow} & below BB`,
    );
    return;
  }

  if (hasOpenPosition() && (r > c.rsiSellAbove || close > upper)) {
    const pos = getPosition();
    const qty = pos ? String(pos.quantity) : c.tradeQty;
    await executeSell(
      symbol,
      qty,
      price,
      r > c.rsiSellAbove
        ? `RSI ${r.toFixed(1)} > ${c.rsiSellAbove}`
        : "above BB upper",
    );
  }
}
