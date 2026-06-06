import { getClosedTrades } from "./tradeLedger.js";
import {
  smallCapitalBelowUsdt,
  smallCapitalMaxTradesDay,
} from "./capitalRules.js";
import { getFreeUsdt } from "./capital.js";

/** Hasta el primer cierre en positivo: entradas más selectivas y TP alcanzable. */
export function firstWinModeEnabled(): boolean {
  return process.env.AUBOT_FIRST_WIN_MODE !== "false";
}

/** Ganancia mínima para contar como "primera victoria" (neto USDT). */
export function meaningfulWinMinUsdt(): number {
  return Math.max(
    0.05,
    Number(process.env.AUBOT_FIRST_WIN_MIN_PNL_USDT || "0.12") || 0.12,
  );
}

export function hasRecordedWin(): boolean {
  const min = meaningfulWinMinUsdt();
  return getClosedTrades(365).some((t) => t.pnlUsdt >= min);
}

export async function firstWinStrictActive(): Promise<boolean> {
  if (!firstWinModeEnabled()) return false;
  if (hasRecordedWin()) return false;
  const free = await getFreeUsdt();
  return free > 0 && free < smallCapitalBelowUsdt();
}

export function firstWinMinScoreBoost(): number {
  if (!firstWinModeEnabled() || hasRecordedWin()) return 0;
  return Number(process.env.AUBOT_FIRST_WIN_SCORE_BOOST || "8") || 8;
}

export function firstWinMaxTradesDay(): number {
  if (!firstWinModeEnabled() || hasRecordedWin()) {
    return smallCapitalMaxTradesDay();
  }
  return Math.max(
    1,
    Number(process.env.AUBOT_FIRST_WIN_MAX_TRADES_DAY || "1") || 1,
  );
}

export function firstWinRequireStrongBuy(): boolean {
  return (
    firstWinModeEnabled() &&
    !hasRecordedWin() &&
    process.env.AUBOT_FIRST_WIN_STRONG_BUY_ONLY !== "false"
  );
}
