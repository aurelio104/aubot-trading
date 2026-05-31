import crypto from "node:crypto";
import { getAccountBalances } from "./binance.js";
import { pushLog } from "./log.js";

const apiKey = process.env.BINANCE_API_KEY || "";
const apiSecret = process.env.BINANCE_API_SECRET || "";
const BASE =
  process.env.BINANCE_TESTNET !== "false"
    ? "https://testnet.binance.vision"
    : "https://api.binance.com";

const STABLE = new Set(["USDT", "USDC", "BUSD", "FDUSD", "TUSD", "DAI", "BNB"]);

function sign(query: string): string {
  return crypto.createHmac("sha256", apiSecret).update(query).digest("hex");
}

async function sapiPost(
  path: string,
  params: Record<string, string | string[]>,
): Promise<unknown> {
  if (!apiKey || !apiSecret) {
    throw new Error("BINANCE_API_KEY/SECRET no configurados");
  }
  const parts: [string, string][] = [];
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) {
      for (const item of v) parts.push([k, item]);
    } else {
      parts.push([k, v]);
    }
  }
  parts.push(["timestamp", String(Date.now())]);
  const query = new URLSearchParams(parts).toString();
  const url = `${BASE}/sapi/v1${path}?${query}&signature=${sign(query)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "X-MBX-APIKEY": apiKey },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Binance ${res.status}: ${text}`);
  return JSON.parse(text) as unknown;
}

export interface DustConvertResult {
  converted: Array<{ asset: string; amount: string; usdt: string }>;
  totalUsdt: number;
  errors: string[];
}

export function dustConvertEnabled(): boolean {
  return process.env.AUBOT_CONVERT_DUST !== "false";
}

interface ConvertibleDetail {
  asset: string;
  amountFree?: string;
  toTargetAssetAmount?: string;
}

/** Polvo Spot → USDT vía Binance dust-convert (targetAsset=USDT). */
export async function convertDustToUsdt(
  extraAssets?: string[],
): Promise<DustConvertResult> {
  const result: DustConvertResult = {
    converted: [],
    totalUsdt: 0,
    errors: [],
  };

  try {
    const query = (await sapiPost(
      "/asset/dust-convert/query-convertible-assets",
      { targetAsset: "USDT", accountType: "SPOT" },
    )) as { details?: ConvertibleDetail[] };

    let assets = (query.details ?? []).map((d) => d.asset).filter(Boolean);

    if (extraAssets?.length) {
      const set = new Set(assets);
      for (const a of extraAssets) {
        if (a && !STABLE.has(a)) set.add(a.toUpperCase());
      }
      assets = [...set];
    }

    if (assets.length === 0) return result;

    const conv = (await sapiPost("/asset/dust-convert/convert", {
      asset: assets,
      targetAsset: "USDT",
      accountType: "SPOT",
    })) as {
      totalTransfered?: string;
      transferResult?: Array<{
        fromAsset: string;
        amount: string;
        transferedAmount: string;
      }>;
    };

    for (const row of conv.transferResult ?? []) {
      result.converted.push({
        asset: row.fromAsset,
        amount: row.amount,
        usdt: row.transferedAmount,
      });
      pushLog(
        "info",
        `dust → USDT: ${row.amount} ${row.fromAsset} = ${row.transferedAmount} USDT`,
      );
    }
    result.totalUsdt = Number(conv.totalTransfered ?? 0);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("-5003") && !msg.includes("no convertible")) {
      result.errors.push(msg);
      pushLog("warn", `dust convert: ${msg}`);
    }
  }

  return result;
}

/** Tras ventas market: convierte cualquier resto por debajo del mínimo. */
export async function convertRemainingDust(): Promise<DustConvertResult> {
  if (!dustConvertEnabled()) {
    return { converted: [], totalUsdt: 0, errors: [] };
  }
  const balances = await getAccountBalances();
  const extras = balances
    .filter(
      (b) =>
        !STABLE.has(b.asset) &&
        !b.asset.startsWith("LD") &&
        Number(b.free) + Number(b.locked) > 0,
    )
    .map((b) => b.asset);
  return convertDustToUsdt(extras);
}
