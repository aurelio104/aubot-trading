import { fetchKlines } from "./binance.js";
import { rsi, toSeries } from "./indicators.js";
import { getConfig } from "./config.js";

export interface MtfAlignment {
  aligned: boolean;
  h1Rsi: number;
  penalty: number;
  reason: string;
}

export function mtfEnabled(): boolean {
  return process.env.AUBOT_MTF_FILTER !== "false";
}

/** 1h no sobrecomprado si 15m dice buy (P4). */
export async function checkMtfAlignment(symbol: string): Promise<MtfAlignment> {
  if (!mtfEnabled()) {
    return { aligned: true, h1Rsi: 50, penalty: 0, reason: "mtf off" };
  }
  try {
    const kl = await fetchKlines(symbol, "1h", 60);
    const closed = kl.slice(0, -1);
    if (closed.length < 20) {
      return { aligned: true, h1Rsi: 50, penalty: 0, reason: "mtf datos insuficientes" };
    }
    const series = toSeries(closed);
    const c = getConfig();
    const rsiValues = rsi(series.closes, c.rsiPeriod);
    const h1 = rsiValues[rsiValues.length - 1] ?? 50;
    const maxH1 = Number(process.env.AUBOT_MTF_H1_RSI_MAX || "52") || 52;
    if (h1 > maxH1) {
      return {
        aligned: false,
        h1Rsi: h1,
        penalty: 15,
        reason: `1h RSI ${h1.toFixed(1)} > ${maxH1} — no alineado`,
      };
    }
    if (h1 > 45) {
      return {
        aligned: true,
        h1Rsi: h1,
        penalty: 5,
        reason: `1h RSI ${h1.toFixed(1)} moderado`,
      };
    }
    return {
      aligned: true,
      h1Rsi: h1,
      penalty: 0,
      reason: `1h RSI ${h1.toFixed(1)} favorable`,
    };
  } catch {
    return { aligned: true, h1Rsi: 50, penalty: 0, reason: "mtf fetch skip" };
  }
}
