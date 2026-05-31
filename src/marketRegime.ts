import { fetchKlines, fetchTickerPrice } from "./binance.js";
import { getConfig } from "./config.js";
import { runMarketAnalysis, type MarketAnalysisResult } from "./marketAnalysis.js";
import { pushLog } from "./log.js";

export type MarketRegime = "BULL" | "LATERAL" | "BEAR";

export interface RegimeSnapshot {
  at: string;
  regime: MarketRegime;
  btcChange4hPct: number;
  strongBuyCount: number;
  sellCount: number;
  minEnterScore: number;
  reason: string;
}

let cached: RegimeSnapshot | null = null;
let cachedAt = 0;

export function marketRegimeEnabled(): boolean {
  return process.env.AUBOT_MARKET_REGIME !== "false";
}

export async function detectMarketRegime(
  analysis?: MarketAnalysisResult,
): Promise<RegimeSnapshot> {
  const now = Date.now();
  if (cached && now - cachedAt < 120_000) return cached;

  const a = analysis ?? (await runMarketAnalysis());
  const cands = a.candidates || [];
  const strongBuy = cands.filter(
    (x) => x.signal === "strong_buy" && x.buyScore >= 70,
  ).length;
  const sells = cands.filter((x) => x.signal === "sell").length;
  const total = Math.max(1, cands.length);

  let btcChange = 0;
  try {
    const kl = await fetchKlines("BTCUSDT", "15m", 20);
    if (kl.length >= 5) {
      const old = kl[kl.length - 17]?.close ?? kl[0].close;
      const cur = kl[kl.length - 1].close;
      btcChange = old > 0 ? ((cur - old) / old) * 100 : 0;
    }
  } catch {
    btcChange = 0;
  }

  let regime: MarketRegime = "LATERAL";
  let minScore = Number(process.env.AUBOT_ENTER_MIN_SCORE || "60") || 60;
  let reason = "condiciones mixtas";

  if (btcChange <= -2 || sells / total > 0.6) {
    regime = "BEAR";
    minScore = Math.max(minScore, 80);
    reason = `BTC ${btcChange.toFixed(1)}% 4h o muchos sell`;
  } else if (btcChange >= 1.5 && strongBuy >= 2) {
    regime = "BULL";
    minScore = Math.max(55, minScore - 5);
    reason = `BTC +${btcChange.toFixed(1)}% y ${strongBuy} strong_buy`;
  } else if (strongBuy === 0) {
    regime = "LATERAL";
    minScore = Math.max(minScore, 75);
    reason = "sin strong_buy claro";
  }

  cached = {
    at: new Date().toISOString(),
    regime,
    btcChange4hPct: Number(btcChange.toFixed(2)),
    strongBuyCount: strongBuy,
    sellCount: sells,
    minEnterScore: minScore,
    reason,
  };
  cachedAt = now;
  pushLog("info", `marketRegime=${regime} btc4h=${btcChange.toFixed(2)}% minScore=${minScore}`);
  return cached;
}

export function getCachedRegime(): RegimeSnapshot | null {
  return cached;
}

export function regimeMinEnterScore(): number {
  return cached?.minEnterScore ?? (Number(process.env.AUBOT_ENTER_MIN_SCORE || "60") || 60);
}
