/**
 * Trades extra cuando el setup es de alta confianza (checklist completo + strong_buy).
 */
import {
  fgBlockBelow,
  maxTradesPerDayEffective,
} from "./capitalPolicy.js";

export interface HighConfidenceSetup {
  checklistAllPassed: boolean;
  signal: string;
  regime: string | null;
  fearGreed: number | null;
  buyScore: number;
  netEdgeUsdt: number;
  minNetEdgeUsdt: number;
}

let lastEligible = false;
let lastEligibleAt = 0;

export function highConfidenceUnlimitedEnabled(): boolean {
  return process.env.AUBOT_HIGH_CONF_UNLIMITED_TRADES !== "false";
}

export function highConfidenceMinScore(): number {
  return Math.max(80, Number(process.env.AUBOT_HIGH_CONF_MIN_SCORE || "85") || 85);
}

/** Tope opcional en modo alta confianza (0 = sin tope práctico). */
export function maxTradesHighConfidence(): number {
  const v = Number(process.env.AUBOT_MAX_TRADES_HIGH_CONF || "0");
  return v > 0 ? v : 999;
}

export function isHighConfidenceSetup(ctx: HighConfidenceSetup): boolean {
  if (!highConfidenceUnlimitedEnabled()) return false;
  if (!ctx.checklistAllPassed) return false;
  if (ctx.signal !== "strong_buy") return false;
  if (ctx.regime === "BEAR") return false;
  if (ctx.fearGreed != null && ctx.fearGreed <= fgBlockBelow()) return false;
  if (ctx.buyScore < highConfidenceMinScore()) return false;
  if (!(ctx.netEdgeUsdt >= ctx.minNetEdgeUsdt)) return false;
  return true;
}

export function setHighConfidenceEligible(eligible: boolean): void {
  lastEligible = eligible;
  lastEligibleAt = Date.now();
}

export function isHighConfidenceEligible(): boolean {
  if (!highConfidenceUnlimitedEnabled()) return false;
  if (Date.now() - lastEligibleAt > 180_000) return false;
  return lastEligible;
}

export function maxTradesAllowedToday(freeUsdt: number): {
  max: number;
  mode: "cautela" | "alta_confianza";
  reason: string;
} {
  const base = maxTradesPerDayEffective(freeUsdt);
  if (isHighConfidenceEligible()) {
    const cap = maxTradesHighConfidence();
    return {
      max: cap,
      mode: "alta_confianza",
      reason:
        cap >= 999
          ? "setup alta confianza — trades/día sin tope (pérdida diaria sí aplica)"
          : `setup alta confianza — hasta ${cap} trades/día`,
    };
  }
  return {
    max: base,
    mode: "cautela",
    reason: `modo cautela — máx ${base} trade(s)/día`,
  };
}

export function canTakeAnotherTradeToday(
  freeUsdt: number,
  tradeCount: number,
): { ok: boolean; max: number; mode: string; reason: string } {
  const { max, mode, reason } = maxTradesAllowedToday(freeUsdt);
  return {
    ok: tradeCount < max,
    max,
    mode,
    reason,
  };
}
