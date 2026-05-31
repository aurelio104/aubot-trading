import { fetchTickerPrice, pingBinance } from "./binance.js";
import { getConfig } from "./config.js";
import { pushLog } from "./log.js";
import { hasOpenPosition, initPositionFromStore, setPositionPersistHook } from "./position.js";
import { runStrategyTick } from "./strategy.js";
import {
  consolidateEnabled,
  consolidateToUsdt,
} from "./consolidateUsdt.js";
import {
  earnProtectionEnabled,
  ensureSpotNotEarn,
} from "./simpleEarn.js";
import {
  findPrimarySpotSymbol,
  syncPositionFromBalances,
} from "./syncPosition.js";
import { getTradingSymbol, setTradingSymbol } from "./tradingSymbol.js";
import {
  loadPersistedPosition,
  persistPosition,
} from "./positionStore.js";

setPositionPersistHook(persistPosition);
initPositionFromStore(loadPersistedPosition());

export type EngineMode = "stopped" | "running" | "paused";

export interface EngineStatus {
  mode: EngineMode;
  symbol: string;
  tickMs: number;
  tickCount: number;
  lastTickAt: string | null;
  lastPrice: number | null;
  lastError: string | null;
  binanceOk: boolean;
  startedAt: string;
}

setTradingSymbol(process.env.AUBOT_SYMBOL || "BTCUSDT");

const tickMs = Math.max(
  250,
  Number(process.env.AUBOT_TICK_MS || "1000") || 1000,
);

let mode: EngineMode = "stopped";
let timer: ReturnType<typeof setInterval> | null = null;
let tickCount = 0;
let lastTickAt: string | null = null;
let lastPrice: number | null = null;
let lastError: string | null = null;
let binanceOk = false;
const startedAt = new Date().toISOString();

async function tick(): Promise<void> {
  if (mode !== "running") return;
  try {
    binanceOk = await pingBinance();
    lastPrice = await fetchTickerPrice(getTradingSymbol());
    lastError = null;
    tickCount += 1;
    lastTickAt = new Date().toISOString();
    if (lastPrice != null) {
      await runStrategyTick(lastPrice);
    }
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    binanceOk = false;
    pushLog("error", `tick: ${lastError}`);
  }
}

export function getStatus(): EngineStatus {
  return {
    mode,
    symbol: getTradingSymbol(),
    tickMs,
    tickCount,
    lastTickAt,
    lastPrice,
    lastError,
    binanceOk,
    startedAt,
  };
}

export function startEngine(): void {
  if (mode === "running") return;
  mode = "running";
  if (timer) clearInterval(timer);
  pushLog("info", `engine start symbol=${getTradingSymbol()} tickMs=${tickMs}`);
  if (earnProtectionEnabled()) {
    void ensureSpotNotEarn().then((r) => {
      if (r.redeemed.length) {
        pushLog(
          "info",
          `engine: redeemed from Earn → Spot: ${r.redeemed.map((x) => `${x.amount} ${x.asset}`).join(", ")}`,
        );
      }
    }).catch((e) => {
      pushLog(
        "warn",
        `earn on start: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }
  if (getConfig().autoTrade && !hasOpenPosition()) {
    void (async () => {
      try {
        if (consolidateEnabled()) {
          await consolidateToUsdt();
        }
        const primary = await findPrimarySpotSymbol();
        if (primary && primary !== getTradingSymbol()) {
          setTradingSymbol(primary);
          pushLog("info", `engine: holding Spot → ${primary}`);
        }
        await syncPositionFromBalances();
      } catch (e) {
        pushLog(
          "warn",
          `sync position: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    })();
  }
  void tick();
  timer = setInterval(() => void tick(), tickMs);
}

export function stopEngine(): void {
  mode = "stopped";
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  pushLog("info", "engine stop");
}

export function pauseEngine(): void {
  mode = "paused";
  pushLog("info", "engine pause");
}

/** Arranque automático si AUBOT_AUTO_START=true (default en prod) */
export function maybeAutoStart(): void {
  const auto = process.env.AUBOT_AUTO_START !== "false";
  if (auto) startEngine();
}
