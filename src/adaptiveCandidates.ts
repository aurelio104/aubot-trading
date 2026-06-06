/**
 * Universo de pares que crece automáticamente con el capital.
 * Mismos gates macro (BTC) para $21 o $1000 — solo cambia qué pares son asequibles.
 */
import { getConfig } from "./config.js";
import { computeQuoteUsdtForTrade } from "./smartCapital.js";
import { BTC_REFERENCE_SYMBOL, btcReferenceEnabled } from "./btcMarketContext.js";

export type CapitalTier = "micro" | "small" | "mid" | "large" | "full";

export interface AdaptiveCandidatePlan {
  at: string;
  freeUsdt: number;
  quoteUsdt: number;
  tier: CapitalTier;
  /** Pares a analizar (incluye BTC referencia si aplica). */
  analysisSymbols: string[];
  /** Pares elegibles para operar (sin BTC si capital insuficiente). */
  tradableSymbols: string[];
  btcTradable: boolean;
  baseCount: number;
  expandedCount: number;
  summaryEs: string;
}

/** Micro — viables con ~15–25 USDT de quote. */
const TIER_MICRO = [
  "DOGEUSDT",
  "ADAUSDT",
  "XRPUSDT",
  "TRXUSDT",
  "SHIBUSDT",
  "PEPEUSDT",
] as const;

/** Small/mid — ~25–80 USDT libres. */
const TIER_MID = [
  "SOLUSDT",
  "LINKUSDT",
  "AVAXUSDT",
  "DOTUSDT",
  "NEARUSDT",
  "SUIUSDT",
  "SEIUSDT",
  "APTUSDT",
  "ARBUSDT",
  "OPUSDT",
  "INJUSDT",
  "ATOMUSDT",
  "FILUSDT",
  "POLUSDT",
  "IMXUSDT",
] as const;

/** Large alts — ~120+ USDT libres. */
const TIER_LARGE = [
  "ETHUSDT",
  "BNBUSDT",
  "LTCUSDT",
  "BCHUSDT",
  "ETCUSDT",
  "AAVEUSDT",
  "UNIUSDT",
  "RENDERUSDT",
  "WLDUSDT",
  "FETUSDT",
  "TIAUSDT",
] as const;

function num(key: string, fallback: number): number {
  const v = Number(process.env[key] ?? "");
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function autoExpandSymbolsEnabled(): boolean {
  return process.env.AUBOT_AUTO_EXPAND_SYMBOLS !== "false";
}

/** Universo máximo (env o tiers integrados). */
export function getSymbolUniverse(): string[] {
  const raw = process.env.AUBOT_SYMBOL_UNIVERSE || "";
  const fromEnv = raw
    .split(/[,;]/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const c = getConfig();
  const merged = [
    ...c.candidateSymbols,
    ...TIER_MICRO,
    ...TIER_MID,
    ...TIER_LARGE,
    BTC_REFERENCE_SYMBOL,
    ...fromEnv,
  ];
  return [...new Set(merged.map((s) => s.toUpperCase()))];
}

function tierThresholds() {
  return {
    mid: num("AUBOT_TIER_MID_USDT", 35),
    large: num("AUBOT_TIER_LARGE_USDT", 120),
    btc: num("AUBOT_TIER_BTC_USDT", 400),
    full: num("AUBOT_TIER_FULL_USDT", 800),
  };
}

export function resolveCapitalTier(
  freeUsdt: number,
  quoteUsdt: number,
): CapitalTier {
  const t = tierThresholds();
  if (freeUsdt >= t.full || quoteUsdt >= t.full * 0.6) return "full";
  if (freeUsdt >= t.btc || quoteUsdt >= t.btc * 0.5) return "large";
  if (freeUsdt >= t.large || quoteUsdt >= 40) return "mid";
  if (freeUsdt >= t.mid || quoteUsdt >= 8) return "small";
  return "micro";
}

function symbolsForTier(tier: CapitalTier, universe: string[]): string[] {
  const inUni = (syms: readonly string[]) =>
    syms.filter((s) => universe.includes(s));
  const c = getConfig();
  const base = c.candidateSymbols.length ? c.candidateSymbols : [...TIER_MICRO];
  const out = new Set<string>(base.map((s) => s.toUpperCase()));

  if (tier === "micro") {
    for (const s of inUni(TIER_MICRO)) out.add(s);
    return [...out];
  }
  for (const s of inUni(TIER_MICRO)) out.add(s);
  for (const s of inUni(TIER_MID)) out.add(s);

  if (tier === "small") return [...out];

  for (const s of inUni(TIER_LARGE)) out.add(s);
  if (tier === "mid") return [...out];

  if (tier === "large" || tier === "full") {
    if (universe.includes(BTC_REFERENCE_SYMBOL)) out.add(BTC_REFERENCE_SYMBOL);
  }
  if (tier === "full") {
    for (const s of universe) {
      if (s.endsWith("USDT")) out.add(s);
    }
  }
  return [...out];
}

export function isBtcTradable(
  freeUsdt: number,
  quoteUsdt: number,
): boolean {
  const t = tierThresholds();
  const minQuote = num("AUBOT_BTC_MIN_QUOTE_USDT", 50);
  return freeUsdt >= t.btc && quoteUsdt >= minQuote;
}

/** Plan de candidatos según capital — mismo cerebro, más pares si hay USDT. */
export function buildAdaptiveCandidatePlan(freeUsdt: number): AdaptiveCandidatePlan {
  const c = getConfig();
  const slPct = c.stopLossPct > 0 ? c.stopLossPct : 1.5;
  const quoteUsdt = computeQuoteUsdtForTrade(freeUsdt, c.capitalPct, slPct);
  const universe = getSymbolUniverse();
  const baseCount = c.candidateSymbols.length;

  let tier = resolveCapitalTier(freeUsdt, quoteUsdt);
  let tradable = autoExpandSymbolsEnabled()
    ? symbolsForTier(tier, universe)
    : [...c.candidateSymbols];

  if (!autoExpandSymbolsEnabled()) {
    tier = isBtcTradable(freeUsdt, quoteUsdt) ? "large" : "small";
  }

  const btcTradable = isBtcTradable(freeUsdt, quoteUsdt);
  if (!btcTradable) {
    tradable = tradable.filter((s) => s !== BTC_REFERENCE_SYMBOL);
  }

  const analysisSymbols = [...tradable];
  if (
    btcReferenceEnabled() &&
    !analysisSymbols.includes(BTC_REFERENCE_SYMBOL)
  ) {
    analysisSymbols.unshift(BTC_REFERENCE_SYMBOL);
  }

  const tierLabel: Record<CapitalTier, string> = {
    micro: "micro (~15–25 USDT)",
    small: "small (~25–80 USDT)",
    mid: "mid (~80–200 USDT)",
    large: "large (~200–800 USDT, BTC posible)",
    full: "full (800+ USDT, universo amplio)",
  };

  const summaryParts = [
    `capital ${freeUsdt.toFixed(2)} USDT`,
    `quote ~${quoteUsdt.toFixed(2)}`,
    `tier ${tierLabel[tier]}`,
    `${tradable.length} pares operables`,
    btcTradable
      ? "BTC operable"
      : "BTC solo referencia macro — mejor alt asequible",
    "mismos gates en todos",
  ];

  return {
    at: new Date().toISOString(),
    freeUsdt,
    quoteUsdt: Number(quoteUsdt.toFixed(4)),
    tier,
    analysisSymbols,
    tradableSymbols: tradable,
    btcTradable,
    baseCount,
    expandedCount: tradable.length,
    summaryEs: summaryParts.join(" · "),
  };
}
