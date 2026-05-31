import { fetchTickerPrice, getAccountBalances, binanceBaseUrl } from "./binance.js";
import { getSymbolFilters } from "./exchangeInfo.js";
import { openLong, getPosition, closePosition } from "./position.js";
import { pushLog } from "./log.js";
import { setTradingSymbol, getTradingSymbol } from "./tradingSymbol.js";
import {
  baseFromLdAsset,
  earnProtectionEnabled,
  ensureSpotNotEarn,
  isEarnLdAsset,
} from "./simpleEarn.js";

const STABLE = new Set(["USDT", "USDC", "BUSD", "FDUSD", "TUSD", "DAI"]);

function tradableAsset(asset: string): string {
  return isEarnLdAsset(asset) ? baseFromLdAsset(asset) : asset;
}

/** Par USDT con mayor valor en Spot (posición manual previa al motor). */
export async function findPrimarySpotSymbol(
  minUsdt = 5,
): Promise<string | null> {
  const balances = await getAccountBalances();
  let best: { symbol: string; value: number } | null = null;
  for (const b of balances) {
    const asset = tradableAsset(b.asset);
    if (STABLE.has(asset)) continue;
    const qty = Number(b.free) + Number(b.locked);
    if (qty < 1e-8) continue;
    const sym = `${asset}USDT`;
    try {
      const price = await fetchTickerPrice(sym);
      const value = qty * price;
      if (value >= minUsdt && (!best || value > best.value)) {
        best = { symbol: sym, value };
      }
    } catch {
      /* par no listado */
    }
  }
  return best?.symbol ?? null;
}

function baseAsset(symbol: string): string {
  if (symbol.endsWith("USDT")) return symbol.slice(0, -4);
  if (symbol.endsWith("BUSD")) return symbol.slice(0, -4);
  return symbol;
}

/** Registra posición LONG desde saldo Spot (tras compra manual o reinicio) */
export async function syncPositionFromBalances(
  symbol?: string,
): Promise<{ synced: boolean; position?: ReturnType<typeof getPosition> }> {
  const sym = (symbol || getTradingSymbol()).toUpperCase();
  setTradingSymbol(sym);
  const asset = baseAsset(sym);
  if (earnProtectionEnabled()) {
    await ensureSpotNotEarn([asset]).catch((e) => {
      pushLog(
        "warn",
        `earn before sync: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }
  const balances = await getAccountBalances();
  const row =
    balances.find((b) => b.asset === asset) ??
    balances.find((b) => isEarnLdAsset(b.asset) && tradableAsset(b.asset) === asset);
  const qty =
    Number(row?.free || 0) + Number(row?.locked || 0);
  if (qty < 1e-8) {
    closePosition();
    return { synced: false };
  }
  const price = await fetchTickerPrice(sym);
  const valueUsdt = qty * price;
  try {
    const filters = await getSymbolFilters(sym, binanceBaseUrl());
    if (qty < filters.minQty || valueUsdt < filters.minNotional) {
      closePosition();
      pushLog(
        "info",
        `sync skip ${sym} — polvo ${valueUsdt.toFixed(4)} USDT (sin posición activa)`,
      );
      return { synced: false };
    }
  } catch {
    if (valueUsdt < 5) {
      closePosition();
      return { synced: false };
    }
  }
  closePosition();
  openLong(price, qty);
  pushLog(
    "info",
    `sync position ${sym} qty=${qty} @${price} (from Spot balance)`,
  );
  return { synced: true, position: getPosition() };
}
