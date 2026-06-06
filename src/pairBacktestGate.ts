/**
 * Fase 3: solo pares con WR histórico > umbral en backtest/demo.
 */
import fs from "node:fs";
import path from "node:path";
import { pushLog } from "./log.js";

export interface PairWrRow {
  symbol: string;
  winRatePct: number;
  trades?: number;
}

let cache: Map<string, number> | null = null;

export function pairWrGateEnabled(): boolean {
  return process.env.AUBOT_PAIR_WR_GATE !== "false";
}

export function minPairWinRatePct(): number {
  return Math.max(30, Number(process.env.AUBOT_MIN_PAIR_WR || "40") || 40);
}

function wrFilePath(): string {
  return (
    process.env.AUBOT_PAIR_WR_JSON ||
    path.join(process.env.AUBOT_JOURNAL_DIR || "/data/journal", "aubot-pair-wr.json")
  );
}

function loadPairWr(): Map<string, number> {
  if (cache) return cache;
  cache = new Map();
  const fp = wrFilePath();
  try {
    if (!fs.existsSync(fp)) {
      pushLog("info", `pairWrGate: sin ${fp} — ejecutar aubot-demo-prueba.sh`);
      return cache;
    }
    const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as {
      pairs?: PairWrRow[];
      results?: PairWrRow[];
    };
    const rows = raw.pairs || raw.results || [];
    for (const r of rows) {
      if (r.symbol && Number.isFinite(r.winRatePct)) {
        cache.set(r.symbol.toUpperCase(), r.winRatePct);
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    pushLog("warn", `pairWrGate load: ${msg}`);
  }
  return cache;
}

export function reloadPairWr(): void {
  cache = null;
}

export function pairAllowedByBacktest(symbol: string): {
  allowed: boolean;
  wr: number | null;
  reason: string;
} {
  if (!pairWrGateEnabled()) {
    return { allowed: true, wr: null, reason: "gate off" };
  }
  const map = loadPairWr();
  if (map.size === 0) {
    return {
      allowed: false,
      wr: null,
      reason: "sin WR por par — se actualiza automáticamente tras cierres/sync",
    };
  }
  const wr = map.get(symbol.toUpperCase()) ?? null;
  const min = minPairWinRatePct();
  if (wr == null) {
    const allowUnknown = process.env.AUBOT_PAIR_WR_UNKNOWN_ALLOW !== "false";
    return {
      allowed: allowUnknown,
      wr: null,
      reason: allowUnknown
        ? `${symbol} sin historial WR — permitido (par nuevo)`
        : `${symbol} sin WR en historial`,
    };
  }
  if (wr < min) {
    return {
      allowed: false,
      wr,
      reason: `${symbol} WR ${wr.toFixed(1)}% < ${min}%`,
    };
  }
  return { allowed: true, wr, reason: `WR ${wr.toFixed(1)}% ≥ ${min}%` };
}
