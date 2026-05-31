import fs from "node:fs";
import path from "node:path";
import {
  fetchTickerPrice,
  getMyTrades,
  type MyTrade,
  type OrderResult,
} from "./binance.js";
import { buildLessons, type TradeLesson } from "./learnFromClose.js";
import { pushLog } from "./log.js";

export interface ClosedTrade {
  id: string;
  symbol: string;
  openedAt: string;
  closedAt: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  quoteInUsdt: number;
  quoteOutUsdt: number;
  feesUsdt: number;
  grossPnlUsdt: number;
  pnlUsdt: number;
  pnlPct: number;
  closeReason: string;
  durationMin: number;
  buyOrderId?: number;
  sellOrderId?: number;
  entryScore?: number;
  entryRsi?: number;
  entrySignal?: string;
  buyReason?: string;
  source: "motor" | "binance_sync";
}

export interface Scorecard {
  at: string;
  days: number;
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  pnlUsdt: number;
  grossPnlUsdt: number;
  feesUsdt: number;
  profitFactor: number;
  maxDrawdownUsdt: number;
  avgWinUsdt: number;
  avgLossUsdt: number;
  bySymbol: Record<string, { n: number; pnl: number; wins: number }>;
}

interface PendingOpen {
  symbol: string;
  openedAt: string;
  entryPrice: number;
  quantity: number;
  quoteInUsdt: number;
  buyOrderId?: number;
  buyReason?: string;
  entryScore?: number;
  entryRsi?: number;
  entrySignal?: string;
  buyFeesUsdt: number;
}

const LEDGER_DIR = process.env.AUBOT_LEDGER_DIR || "/tmp";
const CLOSED_FILE = path.join(LEDGER_DIR, "aubot-closed-trades.jsonl");
const LESSONS_FILE = path.join(LEDGER_DIR, "aubot-lecciones.jsonl");

let closedTrades: ClosedTrade[] = [];
const pendingOpens = new Map<string, PendingOpen>();

function ledgerEnabled(): boolean {
  return process.env.AUBOT_LEDGER_ENABLED !== "false";
}

function appendLine(file: string, row: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + "\n");
  } catch {
    /* read-only fs */
  }
}

function loadClosedFromDisk(): void {
  if (!fs.existsSync(CLOSED_FILE)) return;
  try {
    const rows: ClosedTrade[] = [];
    for (const line of fs.readFileSync(CLOSED_FILE, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line) as ClosedTrade);
      } catch {
        /* skip */
      }
    }
    closedTrades = dedupeTrades(rows);
  } catch {
    /* ignore */
  }
}

function dedupeTrades(rows: ClosedTrade[]): ClosedTrade[] {
  const seen = new Set<string>();
  const out: ClosedTrade[] = [];
  for (const r of rows.sort((a, b) => a.closedAt.localeCompare(b.closedAt))) {
    const key =
      r.sellOrderId != null
        ? `${r.symbol}:${r.sellOrderId}`
        : `${r.symbol}:${r.openedAt}:${r.closedAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

export function initTradeLedger(): void {
  if (!ledgerEnabled()) return;
  loadClosedFromDisk();
  pushLog("info", `ledger: ${closedTrades.length} cierres cargados`);
}

async function commissionToUsdt(t: MyTrade): Promise<number> {
  const comm = Number(t.commission || 0);
  if (comm <= 0) return 0;
  const asset = (t.commissionAsset || "").toUpperCase();
  if (asset === "USDT" || asset === "USDC" || asset === "BUSD") return comm;
  try {
    const px = await fetchTickerPrice(`${asset}USDT`);
    return comm * px;
  } catch {
    return 0;
  }
}

async function feesForOrder(symbol: string, orderId: number): Promise<number> {
  try {
    const trades = await getMyTrades(symbol, { limit: 50 });
    let total = 0;
    for (const t of trades.filter((x) => x.orderId === orderId)) {
      total += await commissionToUsdt(t);
    }
    return total;
  } catch {
    return 0;
  }
}

export function recordBuyFill(
  symbol: string,
  order: Partial<Pick<OrderResult, "orderId" | "cummulativeQuoteQty">> & {
    orderId: number;
  },
  fillPrice: number,
  filledQty: number,
  meta: {
    reason: string;
    score?: number;
    rsi?: number;
    signal?: string;
  },
): void {
  if (!ledgerEnabled()) return;
  const quoteIn = Number(order.cummulativeQuoteQty || fillPrice * filledQty);
  pendingOpens.set(symbol, {
    symbol,
    openedAt: new Date().toISOString(),
    entryPrice: fillPrice,
    quantity: filledQty,
    quoteInUsdt: quoteIn,
    buyOrderId: order.orderId,
    buyReason: meta.reason,
    entryScore: meta.score,
    entryRsi: meta.rsi,
    entrySignal: meta.signal,
    buyFeesUsdt: 0,
  });
  feesForOrder(symbol, order.orderId)
    .then((f) => {
      const p = pendingOpens.get(symbol);
      if (p && p.buyOrderId === order.orderId) p.buyFeesUsdt = f;
    })
    .catch(() => undefined);
}

export async function recordSellClose(
  symbol: string,
  order: Partial<Pick<OrderResult, "orderId" | "cummulativeQuoteQty" | "executedQty">> & {
    orderId: number;
  },
  exitPrice: number,
  soldQty: number,
  closeReason: string,
  fallback?: {
    entryPrice: number;
    quantity: number;
    openedAt?: string;
  },
): Promise<ClosedTrade | null> {
  if (!ledgerEnabled()) return null;

  const pending = pendingOpens.get(symbol);
  const quoteOut = Number(order.cummulativeQuoteQty || exitPrice * soldQty);
  const sellFees = await feesForOrder(symbol, order.orderId);

  const entryPrice = pending?.entryPrice ?? fallback?.entryPrice ?? exitPrice;
  const quantity = pending?.quantity ?? fallback?.quantity ?? soldQty;
  const quoteIn = pending?.quoteInUsdt ?? entryPrice * quantity;
  const buyFees = pending?.buyFeesUsdt ?? 0;
  const feesUsdt = buyFees + sellFees;
  const grossPnl = quoteOut - quoteIn;
  const pnlUsdt = grossPnl - feesUsdt;
  const pnlPct = quoteIn > 0 ? (pnlUsdt / quoteIn) * 100 : 0;
  const openedAt =
    pending?.openedAt ?? fallback?.openedAt ?? new Date().toISOString();
  const closedAt = new Date().toISOString();
  const t0 = new Date(openedAt).getTime();
  const durationMin = t0 > 0 ? (Date.now() - t0) / 60_000 : 0;

  const trade: ClosedTrade = {
    id: `${symbol}-${order.orderId}-${Date.now()}`,
    symbol,
    openedAt,
    closedAt,
    entryPrice,
    exitPrice:
      soldQty > 0 && order.cummulativeQuoteQty
        ? quoteOut / soldQty
        : exitPrice,
    quantity: soldQty,
    quoteInUsdt: round4(quoteIn),
    quoteOutUsdt: round4(quoteOut),
    feesUsdt: round4(feesUsdt),
    grossPnlUsdt: round4(grossPnl),
    pnlUsdt: round4(pnlUsdt),
    pnlPct: round2(pnlPct),
    closeReason,
    durationMin: round2(durationMin),
    buyOrderId: pending?.buyOrderId,
    sellOrderId: order.orderId,
    entryScore: pending?.entryScore,
    entryRsi: pending?.entryRsi,
    entrySignal: pending?.entrySignal,
    buyReason: pending?.buyReason,
    source: "motor",
  };

  closedTrades.push(trade);
  closedTrades = dedupeTrades(closedTrades);
  appendLine(CLOSED_FILE, trade as unknown as Record<string, unknown>);
  pendingOpens.delete(symbol);

  const lessons = buildLessons(trade);
  for (const lesson of lessons) {
    appendLine(LESSONS_FILE, lesson as unknown as Record<string, unknown>);
  }

  pushLog(
    "info",
    `ledger close ${symbol} net=${trade.pnlUsdt >= 0 ? "+" : ""}${trade.pnlUsdt.toFixed(4)} USDT fees=${trade.feesUsdt.toFixed(4)} (${closeReason})`,
  );
  return trade;
}

export async function recordSellClosePaper(
  symbol: string,
  exitPrice: number,
  closeReason: string,
  pos: { entryPrice: number; quantity: number; openedAt?: string },
): Promise<ClosedTrade | null> {
  if (!ledgerEnabled()) return null;
  const fakeOrder = {
    orderId: Date.now(),
    cummulativeQuoteQty: String(exitPrice * pos.quantity),
  } as OrderResult;
  return recordSellClose(symbol, fakeOrder, exitPrice, pos.quantity, closeReason, {
    entryPrice: pos.entryPrice,
    quantity: pos.quantity,
    openedAt: pos.openedAt,
  });
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function mergeClosedTrades(incoming: ClosedTrade[]): number {
  const before = closedTrades.length;
  closedTrades = dedupeTrades([...closedTrades, ...incoming]);
  const added = closedTrades.length - before;
  if (added > 0) {
    for (const t of incoming) {
      appendLine(CLOSED_FILE, t as unknown as Record<string, unknown>);
    }
  }
  return added;
}

export function getClosedTrades(days = 30): ClosedTrade[] {
  const cut = Date.now() - days * 86_400_000;
  return closedTrades.filter(
    (t) => new Date(t.closedAt).getTime() >= cut,
  );
}

export function getLastClosedTrade(): ClosedTrade | null {
  if (!closedTrades.length) return null;
  return closedTrades[closedTrades.length - 1] ?? null;
}

export function getLessons(limit = 50): TradeLesson[] {
  if (!fs.existsSync(LESSONS_FILE)) return [];
  const rows: TradeLesson[] = [];
  try {
    const lines = fs.readFileSync(LESSONS_FILE, "utf8").split("\n");
    for (const line of lines.slice(-limit)) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line) as TradeLesson);
      } catch {
        /* skip */
      }
    }
  } catch {
    /* ignore */
  }
  return rows;
}

export function computeScorecard(days = 30): Scorecard {
  const rows = getClosedTrades(days);
  const pnls = rows.map((r) => r.pnlUsdt);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p <= 0);
  const sumWin = wins.reduce((a, b) => a + b, 0);
  const sumLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const pf =
    sumLoss > 0 ? sumWin / sumLoss : sumWin > 0 ? 999 : 0;

  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const p of pnls) {
    equity += p;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }

  const bySymbol: Scorecard["bySymbol"] = {};
  for (const r of rows) {
    const s = r.symbol;
    bySymbol[s] ??= { n: 0, pnl: 0, wins: 0 };
    bySymbol[s].n += 1;
    bySymbol[s].pnl += r.pnlUsdt;
    if (r.pnlUsdt > 0) bySymbol[s].wins += 1;
  }

  return {
    at: new Date().toISOString(),
    days,
    trades: rows.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: rows.length ? round2((wins.length / rows.length) * 100) : 0,
    pnlUsdt: round4(pnls.reduce((a, b) => a + b, 0)),
    grossPnlUsdt: round4(rows.reduce((a, r) => a + r.grossPnlUsdt, 0)),
    feesUsdt: round4(rows.reduce((a, r) => a + r.feesUsdt, 0)),
    profitFactor: round2(Math.min(pf, 999)),
    maxDrawdownUsdt: round4(maxDd),
    avgWinUsdt: wins.length ? round4(sumWin / wins.length) : 0,
    avgLossUsdt: losses.length ? round4(sumLoss / losses.length) : 0,
    bySymbol: Object.fromEntries(
      Object.entries(bySymbol).map(([k, v]) => [
        k,
        { n: v.n, pnl: round4(v.pnl), wins: v.wins },
      ]),
    ),
  };
}

export { commissionToUsdt, CLOSED_FILE, LESSONS_FILE };
