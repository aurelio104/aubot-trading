import { fetchTickerPrice } from "./binance.js";
import { getCapitalSnapshot } from "./capital.js";
import { getConfig, strategyConfigPublic } from "./config.js";
import {
  getLastAnalysis,
  maybeRotateSymbol,
  runMarketAnalysis,
  setLastAnalysis,
} from "./marketAnalysis.js";
import { getTradingSymbol } from "./tradingSymbol.js";
import { pushLog } from "./log.js";
import {
  getDayStats,
  getRiskBlockReason,
  isRiskBlocked,
  runRiskExits,
} from "./risk.js";
import { getPosition, hasOpenPosition } from "./position.js";
import { runDCA } from "./strategies/dca.js";
import { runGrid, getGridState } from "./strategies/grid.js";
import { runMeanReversion } from "./strategies/meanReversion.js";
import { runThreshold } from "./strategies/threshold.js";
import { maybeAutoEnter } from "./autoEntry.js";
import { getCachedRegime, marketRegimeEnabled } from "./marketRegime.js";
import { getCachedNews, newsContextEnabled } from "./newsContext.js";
import {
  analyzeRotation,
  maybeRotateOnBetterOpportunity,
} from "./rotateOnBetterOpportunity.js";

export async function runStrategyTick(price: number): Promise<void> {
  const c = getConfig();
  if (c.capitalMode) {
    const rotated = await maybeRotateSymbol();
    if (rotated) setLastAnalysis(rotated);
  }

  await runRiskExits(price);

  if (hasOpenPosition()) {
    const switched = await maybeRotateOnBetterOpportunity(price);
    if (switched) return;
  }

  if (!hasOpenPosition()) {
    const entered = await maybeAutoEnter();
    if (entered) return;
  }

  if (!c.autoTrade) {
    return;
  }

  if (isRiskBlocked()) {
    pushLog("warn", `strategy blocked: ${getRiskBlockReason()}`);
    return;
  }

  try {
    switch (c.strategy) {
      case "dca":
        await runDCA(price);
        break;
      case "mean_reversion":
        await runMeanReversion(price);
        break;
      case "grid":
        await runGrid(price);
        break;
      case "threshold":
      default:
        await runThreshold(price);
        break;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    pushLog("error", `strategy ${c.strategy}: ${msg}`);
    throw e;
  }
}

export async function getCurrentPrice(): Promise<number> {
  return fetchTickerPrice(getTradingSymbol());
}

export async function strategyConfig() {
  const capital = getConfig().capitalMode
    ? await getCapitalSnapshot().catch(() => null)
    : null;
  const analysis = getLastAnalysis();
  return {
    ...strategyConfigPublic(),
    symbol: getTradingSymbol(),
    capital,
    analysis: analysis
      ? {
          at: analysis.at,
          freeUsdt: analysis.freeUsdt,
          best: analysis.best,
        }
      : null,
    position: getPosition(),
    risk: {
      blocked: isRiskBlocked(),
      reason: getRiskBlockReason() || null,
      day: getDayStats(),
    },
    grid: getGridState(),
    regime: marketRegimeEnabled() ? getCachedRegime() : null,
    news: newsContextEnabled() ? getCachedNews() : null,
  };
}

export function getStats() {
  return {
    risk: {
      blocked: isRiskBlocked(),
      reason: getRiskBlockReason() || null,
      day: getDayStats(),
    },
    position: getPosition(),
    strategy: getConfig().strategy,
    symbol: getTradingSymbol(),
    grid: getGridState(),
    analysis: getLastAnalysis(),
  };
}

export async function refreshAnalysis() {
  const a = await runMarketAnalysis();
  setLastAnalysis(a);
  return a;
}

export { analyzeRotation, maybeRotateOnBetterOpportunity } from "./rotateOnBetterOpportunity.js";
