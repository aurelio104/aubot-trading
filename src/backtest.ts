/**
 * Backtest offline — mean reversion RSI+BB con TP/SL y capital USDT
 * Uso: npx tsx src/backtest.ts [symbol] [interval] [candles]
 */
import { fetchKlines } from "./binance.js";
import { bollinger, rsi, toSeries } from "./indicators.js";

const symbol = process.argv[2] || "ETHUSDT";
const interval = process.argv[3] || "5m";
const limit = Number(process.argv[4] || "500");

const RSI_BUY = Number(process.env.AUBOT_RSI_BUY_BELOW || "32");
const RSI_SELL = Number(process.env.AUBOT_RSI_SELL_ABOVE || "68");
const BB_PERIOD = Number(process.env.AUBOT_BB_PERIOD || "20");
const BB_STD = Number(process.env.AUBOT_BB_STDDEV || "2");
const RSI_PERIOD = Number(process.env.AUBOT_RSI_PERIOD || "14");
const START_CAPITAL = Number(process.env.AUBOT_BACKTEST_CAPITAL || "20");
const CAPITAL_PCT = Number(process.env.AUBOT_CAPITAL_PCT || "88") / 100;
const RESERVE = Number(process.env.AUBOT_RESERVE_USDT || "2");
const TP_PCT = Number(process.env.AUBOT_TAKE_PROFIT_PCT || "3");
const SL_PCT = Number(process.env.AUBOT_STOP_LOSS_PCT || "2");
const FEE_PCT = Number(process.env.AUBOT_BACKTEST_FEE_PCT || "0.1") / 100;

interface SimTrade {
  entry: number;
  exit: number;
  pnlUsdt: number;
  reason: string;
}

function quoteForTrade(freeUsdt: number): number {
  return Math.max(0, (freeUsdt - RESERVE) * CAPITAL_PCT);
}

function applyFee(notional: number): number {
  return notional * FEE_PCT * 2;
}

async function main(): Promise<void> {
  const klines = await fetchKlines(symbol, interval, limit);
  const closed = klines.slice(0, -1);
  const series = toSeries(closed);
  const rsiV = rsi(series.closes, RSI_PERIOD);
  const bb = bollinger(series.closes, BB_PERIOD, BB_STD);

  let freeUsdt = START_CAPITAL;
  let inPos = false;
  let entry = 0;
  let qty = 0;
  let quoteUsed = 0;
  const trades: SimTrade[] = [];

  for (let i = BB_PERIOD + 1; i < closed.length; i++) {
    const r = rsiV[i];
    const close = series.closes[i];
    const low = series.lows[i];
    const high = series.highs[i];
    const lower = bb.lower[i];
    const upper = bb.upper[i];
    if (Number.isNaN(r) || Number.isNaN(lower)) continue;

    if (inPos) {
      const stop = entry * (1 - SL_PCT / 100);
      const tp = entry * (1 + TP_PCT / 100);
      let exitPrice: number | null = null;
      let reason = "";
      if (low <= stop) {
        exitPrice = stop;
        reason = `stop-loss ${SL_PCT}%`;
      } else if (high >= tp) {
        exitPrice = tp;
        reason = `take-profit ${TP_PCT}%`;
      } else if (r > RSI_SELL || close > upper) {
        exitPrice = close;
        reason = r > RSI_SELL ? `RSI>${RSI_SELL}` : "above BB";
      }
      if (exitPrice != null) {
        const gross = (exitPrice - entry) * qty;
        const fees = applyFee(quoteUsed + exitPrice * qty);
        const pnl = gross - fees;
        freeUsdt += quoteUsed + pnl;
        trades.push({ entry, exit: exitPrice, pnlUsdt: pnl, reason });
        inPos = false;
      }
      continue;
    }

    const quote = quoteForTrade(freeUsdt);
    if (quote < 5) continue;
    if (r < RSI_BUY && close < lower) {
      entry = close;
      qty = quote / close;
      quoteUsed = quote;
      freeUsdt -= quote;
      inPos = true;
    }
  }

  if (inPos) {
    const last = series.closes[series.closes.length - 1];
    const gross = (last - entry) * qty;
    const fees = applyFee(quoteUsed + last * qty);
    const pnl = gross - fees;
    freeUsdt += quoteUsed + pnl;
    trades.push({ entry, exit: last, pnlUsdt: pnl, reason: "open at end" });
  }

  const wins = trades.filter((t) => t.pnlUsdt > 0).length;
  const totalPnl = trades.reduce((a, t) => a + t.pnlUsdt, 0);
  const winRate = trades.length ? (wins / trades.length) * 100 : 0;
  const finalCapital = freeUsdt;
  const returnPct =
    START_CAPITAL > 0
      ? ((finalCapital - START_CAPITAL) / START_CAPITAL) * 100
      : 0;

  console.log(
    JSON.stringify(
      {
        symbol,
        interval,
        candles: closed.length,
        startCapitalUsdt: START_CAPITAL,
        finalCapitalUsdt: Number(finalCapital.toFixed(4)),
        returnPct: Number(returnPct.toFixed(2)),
        trades: trades.length,
        wins,
        losses: trades.length - wins,
        winRatePct: Number(winRate.toFixed(2)),
        totalPnlUsdt: Number(totalPnl.toFixed(4)),
        params: {
          rsiBuy: RSI_BUY,
          rsiSell: RSI_SELL,
          tpPct: TP_PCT,
          slPct: SL_PCT,
          capitalPct: CAPITAL_PCT * 100,
        },
        lastTrades: trades.slice(-3),
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.log(
    JSON.stringify({
      symbol,
      interval,
      error: msg,
      trades: 0,
      winRatePct: 0,
      returnPct: 0,
      finalCapitalUsdt: START_CAPITAL,
      totalPnlUsdt: 0,
    }),
  );
  process.exit(0);
});
