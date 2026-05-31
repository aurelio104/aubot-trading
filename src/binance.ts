import crypto from "node:crypto";

const TESTNET = process.env.BINANCE_TESTNET !== "false";
const BASE = TESTNET
  ? "https://testnet.binance.vision"
  : "https://api.binance.com";

const apiKey = process.env.BINANCE_API_KEY || "";
const apiSecret = process.env.BINANCE_API_SECRET || "";

export function binanceBaseUrl(): string {
  return BASE;
}

export function hasCredentials(): boolean {
  return Boolean(apiKey && apiSecret);
}

function sign(query: string): string {
  return crypto.createHmac("sha256", apiSecret).update(query).digest("hex");
}

export async function signedRequest(
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, string | number> = {},
  sapi = false,
): Promise<unknown> {
  if (!hasCredentials()) {
    throw new Error("BINANCE_API_KEY/SECRET no configurados");
  }
  const ts = Date.now();
  const all: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(params).map(([k, v]) => [k, String(v)]),
    ),
    timestamp: String(ts),
  };
  const query = new URLSearchParams(all).toString();
  const signature = sign(query);
  const prefix = sapi ? "/sapi/v1" : "";
  const fullPath = path.startsWith("/sapi") ? path : `${prefix}${path}`;
  const url = `${BASE}${fullPath}?${query}&signature=${signature}`;
  const res = await fetch(url, {
    method,
    headers: { "X-MBX-APIKEY": apiKey },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Binance ${res.status}: ${text}`);
  return JSON.parse(text) as unknown;
}

export async function fetchTickerPrice(symbol: string): Promise<number> {
  const url = `${BASE}/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Binance ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { price: string };
  return Number(data.price);
}

export async function pingBinance(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/v3/ping`, {
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface AccountBalance {
  asset: string;
  free: string;
  locked: string;
}

export async function getAccountBalances(): Promise<AccountBalance[]> {
  const data = (await signedRequest("GET", "/api/v3/account")) as {
    balances: AccountBalance[];
  };
  return data.balances.filter(
    (b) => Number(b.free) > 0 || Number(b.locked) > 0,
  );
}

export interface FundingAsset {
  asset: string;
  free: string;
  locked: string;
  freeze: string;
  withdrawing: string;
}

/** Billetera Fondos (Funding) — donde suele estar el depósito del usuario */
export async function getFundingAssets(
  asset?: string,
): Promise<FundingAsset[]> {
  const params: Record<string, string> = {};
  if (asset) params.asset = asset;
  const data = (await signedRequest(
    "POST",
    "/asset/get-funding-asset",
    params,
    true,
  )) as FundingAsset[];
  return (data || []).filter(
    (a) =>
      Number(a.free) > 0 ||
      Number(a.locked) > 0 ||
      Number(a.freeze) > 0,
  );
}

export type TransferType = "MAIN_FUNDING" | "FUNDING_MAIN";

/** Transferir entre Spot (MAIN) y Billetera Fondos */
export async function universalTransfer(
  type: TransferType,
  asset: string,
  amount: string,
): Promise<{ tranId: number }> {
  return (await signedRequest(
    "POST",
    "/asset/transfer",
    { type, asset, amount },
    true,
  )) as { tranId: number };
}

export interface WalletSnapshot {
  spot: AccountBalance[];
  funding: FundingAsset[];
  testnet: boolean;
}

export async function getAllWallets(): Promise<
  WalletSnapshot & { fundingError?: string }
> {
  const spot = await getAccountBalances();
  let funding: FundingAsset[] = [];
  let fundingError: string | undefined;
  try {
    funding = await getFundingAssets();
  } catch (e) {
    fundingError =
      e instanceof Error ? e.message : String(e);
  }
  return {
    spot,
    funding,
    testnet: process.env.BINANCE_TESTNET !== "false",
    fundingError,
  };
}

export interface OrderResult {
  orderId: number;
  symbol: string;
  side: string;
  type: string;
  status: string;
  executedQty: string;
  price?: string;
  cummulativeQuoteQty?: string;
}

export interface MyTrade {
  id: number;
  orderId: number;
  symbol: string;
  price: string;
  qty: string;
  quoteQty: string;
  commission: string;
  commissionAsset: string;
  time: number;
  isBuyer: boolean;
  isMaker: boolean;
}

export async function getMyTrades(
  symbol: string,
  opts: { startTime?: number; limit?: number } = {},
): Promise<MyTrade[]> {
  const params: Record<string, string | number> = {
    symbol,
    limit: opts.limit ?? 500,
  };
  if (opts.startTime) params.startTime = opts.startTime;
  const data = (await signedRequest("GET", "/api/v3/myTrades", params)) as MyTrade[];
  return (data || []).sort((a, b) => a.time - b.time);
}

export async function createMarketOrder(
  symbol: string,
  side: "BUY" | "SELL",
  quantity: string,
): Promise<OrderResult> {
  const minute = Math.floor(Date.now() / 60_000);
  const clientOrderId = `aubot${symbol}${side}${minute}`.slice(0, 36);
  return (await signedRequest("POST", "/api/v3/order", {
    symbol,
    side,
    type: "MARKET",
    quantity,
    newClientOrderId: clientOrderId,
  })) as OrderResult;
}

/** Compra market gastando USDT exactos (ideal para capital pequeño). */
export async function createMarketBuyQuote(
  symbol: string,
  quoteOrderQty: string,
): Promise<OrderResult> {
  return (await signedRequest("POST", "/api/v3/order", {
    symbol,
    side: "BUY",
    type: "MARKET",
    quoteOrderQty,
  })) as OrderResult;
}

export async function createLimitOrder(
  symbol: string,
  side: "BUY" | "SELL",
  quantity: string,
  price: string,
): Promise<OrderResult> {
  return (await signedRequest("POST", "/api/v3/order", {
    symbol,
    side,
    type: "LIMIT",
    timeInForce: "GTC",
    quantity,
    price,
  })) as OrderResult;
}

export async function cancelOrder(
  symbol: string,
  orderId: number,
): Promise<unknown> {
  return signedRequest("DELETE", "/api/v3/order", { symbol, orderId });
}

export async function getOpenOrders(symbol?: string): Promise<OrderResult[]> {
  const params: Record<string, string> = {};
  if (symbol) params.symbol = symbol;
  return (await signedRequest("GET", "/api/v3/openOrders", params)) as OrderResult[];
}

export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export async function fetchKlines(
  symbol: string,
  interval: string,
  limit = 100,
): Promise<Kline[]> {
  const url =
    `${BASE}/api/v3/klines?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${encodeURIComponent(interval)}&limit=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Binance ${res.status}: ${await res.text()}`);
  const raw = (await res.json()) as unknown[][];
  return raw.map((k) => ({
    openTime: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    closeTime: Number(k[6]),
  }));
}

/** Cantidad desde USDT quote (market buy aproximado) */
export function qtyFromQuoteUsdt(quoteUsdt: number, price: number): string {
  const q = quoteUsdt / price;
  return q.toFixed(6);
}
