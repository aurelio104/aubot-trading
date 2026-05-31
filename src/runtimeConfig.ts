import { getConfig, type AppConfig } from "./config.js";

const excludedSymbols = new Set<string>();
let circuitOpenUntil = 0;
let slCountRolling = 0;
let slCountDate = "";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function blacklistEnabled(): boolean {
  return process.env.AUBOT_BLACKLIST_ENABLED !== "false";
}

export function setExcludedSymbols(symbols: string[]): void {
  excludedSymbols.clear();
  for (const s of symbols) {
    addExcludedSymbol(s);
  }
}

/** Carga blacklist inicial desde AUBOT_DEFAULT_BLACKLIST (PEPE;RUNE;…). */
export function initDefaultBlacklist(): void {
  const raw = process.env.AUBOT_DEFAULT_BLACKLIST || "";
  if (!raw.trim()) return;
  for (const part of raw.split(/[,;]/)) {
    addExcludedSymbol(part);
  }
}

export function addExcludedSymbol(symbol: string, _untilIso?: string): void {
  excludedSymbols.add(symbol.toUpperCase());
}

export function isBlacklisted(symbol: string): boolean {
  if (!blacklistEnabled()) return false;
  return excludedSymbols.has(symbol.toUpperCase());
}

export function getExcludedSymbols(): string[] {
  return [...excludedSymbols];
}

/** Parchea config en memoria (aprendizaje / control Gurú). */
export function patchStrategyParams(params: {
  rsiBuyBelow?: number;
  rsiSellAbove?: number;
  takeProfitPct?: number;
  stopLossPct?: number;
  capitalPct?: number;
}): AppConfig {
  const c = getConfig();
  if (params.rsiBuyBelow != null && Number.isFinite(params.rsiBuyBelow)) {
    c.rsiBuyBelow = params.rsiBuyBelow;
  }
  if (params.rsiSellAbove != null && Number.isFinite(params.rsiSellAbove)) {
    c.rsiSellAbove = params.rsiSellAbove;
  }
  if (params.takeProfitPct != null && Number.isFinite(params.takeProfitPct)) {
    c.takeProfitPct = params.takeProfitPct;
  }
  if (params.stopLossPct != null && Number.isFinite(params.stopLossPct)) {
    c.stopLossPct = params.stopLossPct;
  }
  if (params.capitalPct != null && Number.isFinite(params.capitalPct)) {
    c.capitalPct = params.capitalPct;
  }
  return { ...c };
}

export function preserveModeActive(freeUsdt: number): boolean {
  if (process.env.AUBOT_PRESERVE_MODE === "true") return true;
  if (process.env.AUBOT_PRESERVE_MODE === "false") return false;
  const minCap = Number(process.env.AUBOT_PRESERVE_CAPITAL_BELOW || "15") || 15;
  return freeUsdt > 0 && freeUsdt < minCap;
}

export function effectiveEnterMinScore(): number {
  const base = Math.max(40, Number(process.env.AUBOT_ENTER_MIN_SCORE || "60") || 60);
  if (process.env.AUBOT_PRESERVE_MODE === "true") {
    return Math.max(base, Number(process.env.AUBOT_PRESERVE_MIN_SCORE || "70") || 70);
  }
  return base;
}

export function minSpotUsdt(): number {
  return Math.max(5, Number(process.env.AUBOT_MIN_SPOT_USDT || "8") || 8);
}

export function paperTradeEnabled(): boolean {
  return process.env.AUBOT_PAPER_TRADE === "true";
}

export function adaptiveTpSlEnabled(): boolean {
  return process.env.AUBOT_ADAPTIVE_TP_SL !== "false";
}

export function maxSlPerDay(): number {
  return Math.max(1, Number(process.env.AUBOT_MAX_SL_DAY || "3") || 3);
}

export function circuitBreakHours(): number {
  return Math.max(1, Number(process.env.AUBOT_CIRCUIT_BREAK_HOURS || "4") || 4);
}

export function isCircuitOpen(): boolean {
  if (Date.now() < circuitOpenUntil) return true;
  if (circuitOpenUntil > 0 && Date.now() >= circuitOpenUntil) {
    circuitOpenUntil = 0;
    slCountRolling = 0;
  }
  return false;
}

export function circuitOpenReason(): string {
  return `circuit_breaker (${slCountRolling} SL en 24h — pausa ${circuitBreakHours()}h)`;
}

export function recordStopLoss(): void {
  const d = today();
  if (slCountDate !== d) {
    slCountDate = d;
    slCountRolling = 0;
  }
  slCountRolling += 1;
  if (slCountRolling >= maxSlPerDay()) {
    circuitOpenUntil = Date.now() + circuitBreakHours() * 3600_000;
  }
}

export function rotateMinEdgeUsdt(): number {
  return Math.max(0.1, Number(process.env.AUBOT_ROTATE_MIN_EDGE_USDT || "0.15") || 0.15);
}

export function stagnantMinScore(): number {
  return Math.max(50, Number(process.env.AUBOT_STAGNANT_MIN_SCORE || "75") || 75);
}

const blockedHoursUtc = new Set<number>();

export function setBlockedHoursUtc(hours: number[]): void {
  blockedHoursUtc.clear();
  for (const h of hours) {
    if (h >= 0 && h <= 23) blockedHoursUtc.add(h);
  }
}

export function isBlockedHourUtc(): boolean {
  if (blockedHoursUtc.size === 0) {
    const raw = process.env.AUBOT_BLOCKED_HOURS_UTC || "";
    for (const part of raw.split(/[,;]/)) {
      const h = Number(part.trim());
      if (Number.isFinite(h) && h >= 0 && h <= 23) blockedHoursUtc.add(h);
    }
  }
  if (blockedHoursUtc.size === 0) return false;
  const h = new Date().getUTCHours();
  return blockedHoursUtc.has(h);
}
