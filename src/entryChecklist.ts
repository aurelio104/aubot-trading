/**
 * Checklist obligatorio antes de cada entrada (Fases 1–4).
 */
import type { NewsSnapshot } from "./newsContext.js";
import type { RegimeSnapshot } from "./marketRegime.js";
import type { EntryConfirmation } from "./entryConfirmation.js";
import type { MtfAlignment } from "./multiTimeframe.js";
import type { SymbolOpportunity } from "./marketAnalysis.js";
import { longRegimeAllowed } from "./marketRegime.js";
import {
  fgBlockBelow,
  rsiEntryMin,
  rsiEntryMax,
  extremeFearMinScore,
  extremeFearHighScore,
  maxRiskUsdt,
  minNetEdgeUsdtForQuote,
  minNetEdgeFeeMult,
} from "./capitalPolicy.js";
import { roundTripFeePct } from "./capitalRules.js";
import { meetsMinRiskReward, minRiskRewardRatio } from "./smartCapital.js";
import { isPsychologyPauseOpen, isCircuitOpen } from "./runtimeConfig.js";
import { normalizeRsi, rsiExtremeLow } from "./rsiFormat.js";
import { pairAllowedByBacktest } from "./pairBacktestGate.js";

export interface ChecklistItem {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface EntryChecklistResult {
  items: ChecklistItem[];
  passed: number;
  total: number;
  allPassed: boolean;
  summaryEs: string;
}

export interface ChecklistContext {
  freeUsdt: number;
  regime: RegimeSnapshot | null;
  news: NewsSnapshot | null;
  best: SymbolOpportunity;
  entryConf: EntryConfirmation;
  mtf: MtfAlignment;
  tpPct: number;
  slPct: number;
  netEdgeUsdt: number;
  lossStreakBlocked: boolean;
  psychologyCritical: boolean;
  canOpen: boolean;
  newsScoreBoost: number;
}

export function buildEntryChecklist(ctx: ChecklistContext): EntryChecklistResult {
  const fg = ctx.news?.fearGreed ?? null;
  const regime = ctx.regime?.regime ?? null;
  const rsi = normalizeRsi(ctx.best.rsi);
  const score = ctx.best.buyScore;
  const riskAtStake = ((ctx.best.quoteUsdt || 0) * ctx.slPct) / 100;
  const maxRisk = maxRiskUsdt(ctx.freeUsdt);
  const feeRt = ((ctx.best.quoteUsdt || 0) * roundTripFeePct()) / 100;
  const minEdge = minNetEdgeUsdtForQuote(ctx.best.quoteUsdt || 0, ctx.freeUsdt);
  const pairGate = pairAllowedByBacktest(ctx.best.symbol);

  const fgOk =
    fg == null ||
    (fg > fgBlockBelow()) ||
    (ctx.newsScoreBoost > 0 && score >= extremeFearHighScore());

  const rsiOk =
    rsi >= rsiEntryMin() &&
    rsi <= rsiEntryMax() &&
    !rsiExtremeLow(rsi);

  const extremeFearScoreOk =
    fg == null || fg > fgBlockBelow() || score >= extremeFearMinScore();

  const items: ChecklistItem[] = [
    {
      id: "regime",
      label: "Régimen ≠ BEAR (BULL/NEUTRAL)",
      ok: regime !== "BEAR" && longRegimeAllowed(regime ?? undefined),
      detail: regime ?? "?",
    },
    {
      id: "fg",
      label: `F&G > ${fgBlockBelow()} o score ≥ ${extremeFearHighScore()} con boost`,
      ok: fgOk && (fg == null || fg > fgBlockBelow() || extremeFearScoreOk),
      detail: fg != null ? `F&G=${fg} score=${score}` : "F&G n/d",
    },
    {
      id: "rsi",
      label: `RSI ${rsiEntryMin()}–${rsiEntryMax()} (no cuchillo)`,
      ok: rsiOk,
      detail: `RSI=${rsi.toFixed(1)}`,
    },
    {
      id: "rejection",
      label: "Soporte BB + vela de rechazo",
      ok: ctx.entryConf.confirmed && ctx.entryConf.rejectionCandle,
      detail: ctx.entryConf.reason,
    },
    {
      id: "volume",
      label: "Volumen > media 20 velas",
      ok: (ctx.best.volumeOk ?? false) && ctx.entryConf.volumeOk,
      detail: `${ctx.best.volumeRatio ?? "?"}× media`,
    },
    {
      id: "rr",
      label: `R:R ≥ ${minRiskRewardRatio()}:1`,
      ok: meetsMinRiskReward(ctx.tpPct, ctx.slPct),
      detail: `TP ${ctx.tpPct}% / SL ${ctx.slPct}%`,
    },
    {
      id: "risk",
      label: `Riesgo ≤ ${maxRisk.toFixed(2)} USDT (2% capital)`,
      ok: riskAtStake <= maxRisk * 1.05,
      detail: `SL ~${riskAtStake.toFixed(3)} USDT`,
    },
    {
      id: "tpsl",
      label: "SL y TP definidos antes de entrar",
      ok: ctx.tpPct > 0 && ctx.slPct > 0,
      detail: `TP ${ctx.tpPct}% SL ${ctx.slPct}%`,
    },
    {
      id: "pause",
      label: "Sin pausa activa (1–2h tras racha pérdidas)",
      ok:
        !ctx.psychologyCritical &&
        !ctx.lossStreakBlocked &&
        !isPsychologyPauseOpen() &&
        !isCircuitOpen(),
      detail: ctx.lossStreakBlocked ? "racha pérdidas" : "OK",
    },
    {
      id: "edge",
      label: `Ganancia neta > fees × ${minNetEdgeFeeMult()}`,
      ok: ctx.netEdgeUsdt >= minEdge,
      detail: `net ${ctx.netEdgeUsdt.toFixed(3)} vs min ${minEdge.toFixed(3)} USDT`,
    },
    {
      id: "mtf",
      label: "MTF: señal 15m + 1h no bajista",
      ok: ctx.mtf.aligned,
      detail: ctx.mtf.reason,
    },
    {
      id: "pair_wr",
      label: "Par WR backtest ≥ 40%",
      ok: pairGate.allowed,
      detail: pairGate.reason,
    },
    {
      id: "can_open",
      label: "canOpenNewTrade + capital real OK",
      ok: ctx.canOpen,
      detail: ctx.canOpen ? "OK" : "bloqueado",
    },
  ];

  const passed = items.filter((i) => i.ok).length;
  const total = items.length;
  const allPassed = passed === total;

  return {
    items,
    passed,
    total,
    allPassed,
    summaryEs: allPassed
      ? `Checklist ${passed}/${total} ✓ — ENTER_CANDIDATE permitido`
      : `Checklist ${passed}/${total} — falta: ${items.filter((i) => !i.ok).slice(0, 3).map((i) => i.id).join(", ")}`,
  };
}
