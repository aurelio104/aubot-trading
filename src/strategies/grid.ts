import fs from "node:fs";
import {
  cancelOrder,
  createLimitOrder,
  getOpenOrders,
  type OrderResult,
} from "../binance.js";
import { getConfig } from "../config.js";
import { pushLog } from "../log.js";
import { isRiskBlocked } from "../risk.js";

interface GridLevel {
  price: number;
  buyOrderId?: number;
  sellOrderId?: number;
  filledBuy?: boolean;
}

interface GridState {
  symbol: string;
  levels: GridLevel[];
  initialized: boolean;
}

let state: GridState | null = null;

function roundPrice(p: number): string {
  return p.toFixed(2);
}

function roundQty(q: number): string {
  return q.toFixed(6);
}

function buildLevels(
  lower: number,
  upper: number,
  count: number,
  mode: "arithmetic" | "geometric",
): number[] {
  const levels: number[] = [];
  if (mode === "arithmetic") {
    const step = (upper - lower) / (count - 1);
    for (let i = 0; i < count; i++) levels.push(lower + step * i);
  } else {
    const ratio = (upper / lower) ** (1 / (count - 1));
    for (let i = 0; i < count; i++) levels.push(lower * ratio ** i);
  }
  return levels;
}

function loadState(symbol: string): GridState {
  const c = getConfig();
  if (state && state.symbol === symbol) return state;
  try {
    if (fs.existsSync(c.gridStatePath)) {
      const raw = JSON.parse(fs.readFileSync(c.gridStatePath, "utf8")) as GridState;
      if (raw.symbol === symbol) {
        state = raw;
        return state;
      }
    }
  } catch {
    pushLog("warn", "grid: could not load state file");
  }
  state = { symbol, levels: [], initialized: false };
  return state;
}

function saveState(): void {
  const c = getConfig();
  if (!state) return;
  try {
    fs.writeFileSync(c.gridStatePath, JSON.stringify(state, null, 2));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    pushLog("warn", `grid: save state failed: ${msg}`);
  }
}

function qtyPerLevel(price: number): string {
  const c = getConfig();
  const perLevel = c.gridInvestmentUsdt / c.gridLevels;
  return roundQty(perLevel / price);
}

async function initGrid(price: number): Promise<void> {
  const c = getConfig();
  if (c.gridLower <= 0 || c.gridUpper <= 0 || c.gridLower >= c.gridUpper) {
    pushLog("warn", "grid: set AUBOT_GRID_LOWER and AUBOT_GRID_UPPER");
    return;
  }

  const prices = buildLevels(
    c.gridLower,
    c.gridUpper,
    c.gridLevels,
    c.gridSpacing,
  );
  const st = loadState(c.symbol);
  st.levels = prices.map((p) => ({ price: p }));
  st.initialized = true;

  for (const level of st.levels) {
    if (level.price >= price) continue;
    try {
      const order = await createLimitOrder(
        c.symbol,
        "BUY",
        qtyPerLevel(level.price),
        roundPrice(level.price),
      );
      level.buyOrderId = order.orderId;
      pushLog("info", `grid BUY limit @${level.price} id=${order.orderId}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pushLog("error", `grid init buy: ${msg}`);
    }
  }
  saveState();
}

function nextLevelUp(levelPrice: number): GridLevel | undefined {
  if (!state) return undefined;
  const sorted = [...state.levels].sort((a, b) => a.price - b.price);
  return sorted.find((l) => l.price > levelPrice);
}

async function syncFills(open: OrderResult[], price: number): Promise<void> {
  const c = getConfig();
  const openIds = new Set(open.map((o) => o.orderId));

  for (const level of state?.levels ?? []) {
    if (level.buyOrderId && !openIds.has(level.buyOrderId) && !level.filledBuy) {
      level.filledBuy = true;
      level.buyOrderId = undefined;
      pushLog("info", `grid buy filled @${level.price}`);
      const up = nextLevelUp(level.price);
      if (up && !up.sellOrderId) {
        try {
          const order = await createLimitOrder(
            c.symbol,
            "SELL",
            qtyPerLevel(up.price),
            roundPrice(up.price),
          );
          up.sellOrderId = order.orderId;
          pushLog("info", `grid SELL limit @${up.price} id=${order.orderId}`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          pushLog("error", `grid sell place: ${msg}`);
        }
      }
    }
    if (level.sellOrderId && !openIds.has(level.sellOrderId)) {
      level.sellOrderId = undefined;
      level.filledBuy = false;
      pushLog("info", `grid sell filled @${level.price}`);
      try {
        const order = await createLimitOrder(
          c.symbol,
          "BUY",
          qtyPerLevel(level.price),
          roundPrice(level.price),
        );
        level.buyOrderId = order.orderId;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        pushLog("error", `grid rebuy: ${msg}`);
      }
    }
  }

  if (c.gridStopLossPct > 0 && price < c.gridLower * (1 - c.gridStopLossPct / 100)) {
    pushLog("warn", "grid stop-loss — canceling open orders");
    for (const o of open) {
      await cancelOrder(c.symbol, o.orderId).catch(() => undefined);
    }
    state!.initialized = false;
    state!.levels = [];
    saveState();
  }
  saveState();
}

export async function runGrid(price: number): Promise<void> {
  if (isRiskBlocked()) return;
  const c = getConfig();
  const st = loadState(c.symbol);

  if (!st.initialized) {
    await initGrid(price);
    return;
  }

  const open = await getOpenOrders(c.symbol);
  await syncFills(open, price);
}

export function getGridState(): GridState | null {
  return state;
}
