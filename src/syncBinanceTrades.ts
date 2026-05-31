import { getMyTrades, type MyTrade } from "./binance.js";
import { pushLog } from "./log.js";
import {
  commissionToUsdt,
  mergeClosedTrades,
  type ClosedTrade,
} from "./tradeLedger.js";

function candidateSymbols(): string[] {
  const raw =
    process.env.AUBOT_CANDIDATE_SYMBOLS ||
    "SHIBUSDT;PEPEUSDT;UNIUSDT;SANDUSDT;LTCUSDT;ARBUSDT;STXUSDT;APTUSDT;RUNEUSDT;LINKUSDT;XRPUSDT;AVAXUSDT";
  return raw
    .split(/[;,]/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

interface Lot {
  time: number;
  qty: number;
  price: number;
  quote: number;
  fees: number;
  orderId: number;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function syncTradesFromBinance(
  days = 30,
): Promise<{ added: number; scanned: number; trades: ClosedTrade[] }> {
  const startTime = Date.now() - days * 86_400_000;
  const symbols = candidateSymbols();
  const allClosed: ClosedTrade[] = [];

  for (const symbol of symbols) {
    let trades: MyTrade[];
    try {
      trades = await getMyTrades(symbol, { startTime, limit: 1000 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/Invalid symbol|does not exist/i.test(msg)) {
        pushLog("warn", `sync trades ${symbol}: ${msg}`);
      }
      continue;
    }
    if (!trades.length) continue;

    const lots: Lot[] = [];
    for (const t of trades) {
      const qty = Number(t.qty);
      const quote = Number(t.quoteQty);
      const price = Number(t.price);
      const fee = await commissionToUsdt(t);
      if (t.isBuyer) {
        lots.push({
          time: t.time,
          qty,
          price,
          quote,
          fees: fee,
          orderId: t.orderId,
        });
      } else {
        let sellQty = qty;
        let sellQuote = quote;
        let sellFees = fee;
        const sellOrderId = t.orderId;
        const sellTime = t.time;

        while (sellQty > 1e-12 && lots.length > 0) {
          const lot = lots[0]!;
          const matchQty = Math.min(sellQty, lot.qty);
          const ratio = matchQty / lot.qty;
          const matchQuoteIn = lot.quote * ratio;
          const matchBuyFees = lot.fees * ratio;
          const matchSellFees = sellFees * (matchQty / qty);
          const matchQuoteOut = sellQuote * (matchQty / qty);
          const gross = matchQuoteOut - matchQuoteIn;
          const net = gross - matchBuyFees - matchSellFees;

          allClosed.push({
            id: `${symbol}-${sellOrderId}-${lot.orderId}-${lot.time}`,
            symbol,
            openedAt: new Date(lot.time).toISOString(),
            closedAt: new Date(sellTime).toISOString(),
            entryPrice: lot.price,
            exitPrice: matchQuoteOut / matchQty,
            quantity: round4(matchQty),
            quoteInUsdt: round4(matchQuoteIn),
            quoteOutUsdt: round4(matchQuoteOut),
            feesUsdt: round4(matchBuyFees + matchSellFees),
            grossPnlUsdt: round4(gross),
            pnlUsdt: round4(net),
            pnlPct: matchQuoteIn > 0 ? round2((net / matchQuoteIn) * 100) : 0,
            closeReason: "binance_sync",
            durationMin: round2((sellTime - lot.time) / 60_000),
            buyOrderId: lot.orderId,
            sellOrderId,
            source: "binance_sync",
          });

          lot.qty -= matchQty;
          lot.quote -= matchQuoteIn;
          lot.fees -= matchBuyFees;
          sellQty -= matchQty;
          if (lot.qty <= 1e-12) lots.shift();
        }
      }
    }
  }

  allClosed.sort((a, b) => a.closedAt.localeCompare(b.closedAt));
  const added = mergeClosedTrades(allClosed);
  pushLog(
    "info",
    `sync binance trades: scanned ${symbols.length} symbols, ${allClosed.length} fills → +${added} new`,
  );
  return { added, scanned: symbols.length, trades: allClosed };
}

export async function applyLearningFromScorecard(
  scorecard: ReturnType<typeof import("./tradeLedger.js").computeScorecard>,
): Promise<Record<string, unknown>> {
  const suggest: Record<string, unknown> = {
    at: new Date().toISOString(),
    tradesAnalyzed: scorecard.trades,
    winRatePct: scorecard.winRatePct,
    pnlUsdt: scorecard.pnlUsdt,
    feesUsdt: scorecard.feesUsdt,
    adjustments: [] as string[],
    suggestedRsiBuyBelow: 30,
    suggestedTakeProfitPct: 3.0,
    suggestedStopLossPct: 2.0,
    suggestedCapitalPct: 88,
  };

  const adj = suggest.adjustments as string[];
  const wr = scorecard.winRatePct;
  const n = scorecard.trades;

  if (n >= 2 && wr < 45) {
    adj.push("WR bajo: más selectivo — RSI 28, TP 2.5%, capital 70%");
    suggest.suggestedRsiBuyBelow = 28;
    suggest.suggestedTakeProfitPct = 2.5;
    suggest.suggestedStopLossPct = 1.6;
    suggest.suggestedCapitalPct = 70;
  } else if (n >= 3 && wr >= 55) {
    adj.push("WR aceptable: mantener TP 3% SL 2%");
  }

  if (scorecard.feesUsdt > Math.abs(scorecard.pnlUsdt) * 0.5 && n >= 2) {
    adj.push("Fees altos vs PnL: subir min net edge y reducir reentradas");
    suggest.suggestedMinNetEdgeUsdt = 0.2;
  }

  const worst = Object.entries(scorecard.bySymbol)
    .filter(([, v]) => v.n >= 2 && v.pnl < 0)
    .sort((a, b) => a[1].pnl - b[1].pnl)[0];
  if (worst) {
    adj.push(`Par débil ${worst[0]}: ${worst[1].n} trades, ${worst[1].pnl.toFixed(4)} USDT — blacklist candidato`);
    suggest.blacklistCandidate = worst[0];
  }

  if (!adj.length) adj.push("Muestra insuficiente o neutra — sin cambio fuerte");

  return suggest;
}
