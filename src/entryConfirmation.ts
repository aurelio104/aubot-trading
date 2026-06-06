/**
 * Confirmación de entrada — evita comprar cuchillo cayendo (RSI extremo sin reversión).
 */
import { fetchKlines } from "./binance.js";
import { getConfig } from "./config.js";
import { bollinger, rsi, toSeries } from "./indicators.js";

export interface EntryConfirmation {
  confirmed: boolean;
  rsi: number;
  volumeOk: boolean;
  rejectionCandle: boolean;
  rsiInZone: boolean;
  notFallingKnife: boolean;
  reason: string;
}

function meanReversionRsiMin(): number {
  return Math.max(15, Number(process.env.AUBOT_MEAN_REVERSION_RSI_MIN || "20") || 20);
}

function meanReversionRsiMax(): number {
  return Math.min(40, Number(process.env.AUBOT_MEAN_REVERSION_RSI_MAX || "35") || 35);
}

function volumeMultMin(): number {
  return Math.max(1, Number(process.env.AUBOT_ENTRY_VOLUME_MULT || "1") || 1);
}

export function entryConfirmationEnabled(): boolean {
  return process.env.AUBOT_ENTRY_CONFIRMATION !== "false";
}

/** Vela de rechazo alcista: cierre > apertura, o mecha inferior larga. */
function hasBullishRejection(
  open: number,
  high: number,
  low: number,
  close: number,
): boolean {
  if (close > open) return true;
  const body = Math.abs(close - open);
  const lowerWick = Math.min(open, close) - low;
  if (body < 1e-12) return lowerWick > 0 && high - low > 0;
  return lowerWick >= body * 1.2;
}

/** Últimas 3 velas no son caída libre (3 rojas con mínimos decrecientes). */
function isFallingKnife(closes: number[], opens: number[]): boolean {
  if (closes.length < 3) return false;
  const n = closes.length;
  let redStreak = 0;
  let lowerLows = 0;
  for (let j = n - 3; j < n; j++) {
    if (closes[j] < opens[j]) redStreak += 1;
    if (j > n - 3 && closes[j] < closes[j - 1]) lowerLows += 1;
  }
  return redStreak >= 3 && lowerLows >= 2;
}

export async function checkEntryConfirmation(symbol: string): Promise<EntryConfirmation> {
  if (!entryConfirmationEnabled()) {
    return {
      confirmed: true,
      rsi: 50,
      volumeOk: true,
      rejectionCandle: true,
      rsiInZone: true,
      notFallingKnife: true,
      reason: "confirmación off",
    };
  }

  const c = getConfig();
  try {
    const klines = await fetchKlines(symbol, c.klineInterval, 80);
    const closed = klines.slice(0, -1);
    if (closed.length < 25) {
      return {
        confirmed: false,
        rsi: 50,
        volumeOk: false,
        rejectionCandle: false,
        rsiInZone: false,
        notFallingKnife: true,
        reason: "datos insuficientes para confirmar entrada",
      };
    }

    const series = toSeries(closed);
    const i = closed.length - 1;
    const rsiValues = rsi(series.closes, c.rsiPeriod);
    const r = rsiValues[i] ?? 50;
    const last = closed[i];
    const open = last.open;
    const high = last.high;
    const low = last.low;
    const close = last.close;

    const rsiMin = meanReversionRsiMin();
    const rsiMax = meanReversionRsiMax();
    const rsiInZone = r >= rsiMin && r <= rsiMax;

    const vols = series.volumes;
    const avgVol =
      vols.slice(Math.max(0, i - 19), i + 1).reduce((a, v) => a + v, 0) /
      Math.min(20, i + 1);
    const volumeOk = avgVol <= 0 || vols[i] > avgVol * volumeMultMin();

    const rejectionCandle = hasBullishRejection(open, high, low, close);
    const fallingKnife = isFallingKnife(
      series.closes.slice(-3),
      closed.slice(-3).map((k) => k.open),
    );
    const notFallingKnife = !fallingKnife;

    const bb = bollinger(series.closes, c.bbPeriod, c.bbStdDev);
    const nearLower = close <= (bb.lower[i] ?? close) * 1.005;

    const confirmed =
      rsiInZone &&
      volumeOk &&
      rejectionCandle &&
      notFallingKnife &&
      nearLower;

    const parts: string[] = [];
    if (!rsiInZone) {
      parts.push(
        r < rsiMin
          ? `RSI ${r.toFixed(1)} < ${rsiMin} (cuchillo — esperar rebote)`
          : `RSI ${r.toFixed(1)} > ${rsiMax} (no zona mean-reversion)`,
      );
    }
    if (!volumeOk) parts.push("volumen bajo vs media 20 velas");
    if (!rejectionCandle) parts.push("sin vela de rechazo alcista");
    if (!notFallingKnife) parts.push("caída libre 3 velas — no atrapar");
    if (!nearLower) parts.push("precio no en banda inferior BB");

    return {
      confirmed,
      rsi: r,
      volumeOk,
      rejectionCandle,
      rsiInZone,
      notFallingKnife,
      reason: confirmed
        ? `confirmado RSI=${r.toFixed(1)} vol OK rechazo BB`
        : parts.join("; ") || "sin confirmación",
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      confirmed: false,
      rsi: 50,
      volumeOk: false,
      rejectionCandle: false,
      rsiInZone: false,
      notFallingKnife: true,
      reason: `confirmación error: ${msg}`,
    };
  }
}
