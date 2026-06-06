/** Filtros LOT_SIZE / NOTIONAL de Binance (cache en memoria). */

export interface SymbolFilters {
  stepSize: number;
  minQty: number;
  maxQty: number;
  minNotional: number;
}

const cache = new Map<string, SymbolFilters>();
let exchangeLoadedAt = 0;
const CACHE_MS = 3_600_000;

function parseFilter(
  filters: { filterType: string; [k: string]: string }[],
): SymbolFilters | null {
  let stepSize = 0.00001;
  let minQty = 0;
  let maxQty = 1e12;
  let minNotional = 5;
  for (const f of filters) {
    if (f.filterType === "LOT_SIZE") {
      stepSize = Number(f.stepSize) || stepSize;
      minQty = Number(f.minQty) || minQty;
      maxQty = Number(f.maxQty) || maxQty;
    }
    if (f.filterType === "NOTIONAL" || f.filterType === "MIN_NOTIONAL") {
      minNotional =
        Number(f.minNotional || (f as { notional?: string }).notional) ||
        minNotional;
    }
  }
  return { stepSize, minQty, maxQty, minNotional };
}

export async function getSymbolFilters(
  symbol: string,
  baseUrl: string,
): Promise<SymbolFilters> {
  const hit = cache.get(symbol);
  if (hit && Date.now() - exchangeLoadedAt < CACHE_MS) return hit;

  const url = `${baseUrl}/api/v3/exchangeInfo?symbol=${encodeURIComponent(symbol)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`exchangeInfo ${res.status}`);
  const data = (await res.json()) as {
    symbols: { symbol: string; filters: { filterType: string; [k: string]: string }[] }[];
  };
  const sym = data.symbols[0];
  if (!sym) throw new Error(`symbol ${symbol} not found`);
  const parsed = parseFilter(sym.filters);
  if (!parsed) throw new Error(`filters ${symbol}`);
  cache.set(symbol, parsed);
  exchangeLoadedAt = Date.now();
  return parsed;
}

export function qtyDecimals(stepSize: number): number {
  if (stepSize >= 1) return 0;
  const s = stepSize.toString();
  if (s.includes("e-")) {
    const exp = Number(s.split("e-")[1]);
    return Number.isFinite(exp) ? Math.min(8, exp) : 8;
  }
  return Math.min(8, (s.split(".")[1] || "").length);
}

export function floorQtyToStep(qty: number, stepSize: number): number {
  if (stepSize <= 0) return qty;
  const steps = Math.floor(qty / stepSize);
  const q = steps * stepSize;
  return Number(q.toFixed(qtyDecimals(stepSize)));
}

export function formatQtyString(qty: number, stepSize: number): string {
  const floored = floorQtyToStep(qty, stepSize);
  return floored.toFixed(qtyDecimals(stepSize));
}
