import { fetchKlines } from "./binance.js";
import { runMarketAnalysis, type MarketAnalysisResult } from "./marketAnalysis.js";
import { pushLog } from "./log.js";

/** BULL = tendencia alcista; NEUTRAL = rango apto mean-reversion; BEAR = sin LONG. */
export type MarketRegime = "BULL" | "NEUTRAL" | "BEAR";

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

export function longRegimeGateEnabled(): boolean {
  return process.env.AUBOT_LONG_REGIME_GATE !== "false";
}

/** LONG permitido solo en BULL o NEUTRAL (no BEAR). */
export function longRegimeAllowed(regime: MarketRegime | null | undefined): boolean {
  if (!regime) return false;
  return regime === "BULL" || regime === "NEUTRAL";
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

  const bearBtc = Number(process.env.AUBOT_BEAR_BTC_PCT || "-0.5") || -0.5;
  const bullBtc = Number(process.env.AUBOT_BULL_BTC_PCT || "1.2") || 1.2;

  let regime: MarketRegime = "NEUTRAL";
  let minScore = Number(process.env.AUBOT_ENTER_MIN_SCORE || "60") || 60;
  let reason = "rango neutral — mean-reversion permitido";

  if (btcChange <= bearBtc || sells / total > 0.5) {
    regime = "BEAR";
    minScore = Math.max(minScore, 85);
    reason =
      btcChange <= bearBtc
        ? `BTC ${btcChange.toFixed(1)}% — régimen BEAR, LONG bloqueado`
        : "muchas señales sell — régimen BEAR";
  } else if (btcChange >= bullBtc && strongBuy >= 1) {
    regime = "BULL";
    minScore = Math.max(55, minScore - 5);
    reason = `BTC +${btcChange.toFixed(1)}% — régimen BULL`;
  } else if (strongBuy === 0 && btcChange < 0.3) {
    regime = "NEUTRAL";
    minScore = Math.max(minScore, 72);
    reason = "neutral sin strong_buy — umbral elevado";
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
  pushLog(
    "info",
    `marketRegime=${regime} btc4h=${btcChange.toFixed(2)}% minScore=${minScore}`,
  );
  return cached;
}

export function getCachedRegime(): RegimeSnapshot | null {
  return cached;
}

export function regimeMinEnterScore(): number {
  return cached?.minEnterScore ?? (Number(process.env.AUBOT_ENTER_MIN_SCORE || "60") || 60);
}
