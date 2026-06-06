/**
 * Recuperación inteligente tras racha de pérdidas — pausas cortas + análisis + auto-ajuste.
 * Racha 1: ajuste ligero, sin bloqueo largo.
 * Racha 2: pausa 1h + análisis exhaustivo últimas 2 ops + corrección.
 * Racha 3+: pausa 2h + análisis profundo + simulación 20min + reanudar si mercado OK.
 */
import { fetchKlines } from "./binance.js";
import { pushLog } from "./log.js";
import { runAutoApplyLearning } from "./autoLearning.js";
import { buildLessons } from "./learnFromClose.js";
import { runMarketAnalysis } from "./marketAnalysis.js";
import { getFreeUsdt } from "./capital.js";
import { getConfig } from "./config.js";
import {
  clearPsychologyPause,
  isPsychologyPauseOpen,
  openPsychologyPause,
  psychologyPauseReason,
} from "./runtimeConfig.js";
import { getClosedTrades, type ClosedTrade } from "./tradeLedger.js";
import fs from "node:fs";
import path from "node:path";

const RECOVERY_DIR = process.env.AUBOT_LEDGER_DIR || "/tmp";
const RECOVERY_FILE = path.join(RECOVERY_DIR, "aubot-loss-streak-recovery.json");

export interface TradeLossReview {
  symbol: string;
  pnlUsdt: number;
  closeReason: string;
  entryScore?: number;
  entryRsi?: number;
  lessonEs: string;
}

export interface ForwardSim20m {
  symbol: string;
  entryPrice: number;
  change20mPct: number;
  projectedPnlPct: number;
  verdict: "favorable" | "neutral" | "adverse";
  detailEs: string;
}

export interface LossStreakRecoveryReport {
  at: string;
  streak: number;
  pauseHours: number;
  paused: boolean;
  tradeReviews: TradeLossReview[];
  simulation: ForwardSim20m | null;
  learningApplied: boolean;
  decisionAction: string;
  resumeReady: boolean;
  summaryEs: string;
}

let recoveryRunning = false;
let lastRecoveryStreak = 0;

/** Racha de pérdidas consecutivas recientes. */
export function recentLossStreak(lookbackDays = 7): number {
  const maxStreak = Math.max(
    1,
    Number(process.env.AUBOT_PRE_ENTRY_LOSS_STREAK || "2") || 2,
  );
  const trades = getClosedTrades(lookbackDays);
  if (!trades.length) return 0;
  let streak = 0;
  for (const t of [...trades].reverse()) {
    if ((t.pnlUsdt ?? 0) <= 0) streak += 1;
    else break;
    if (streak >= maxStreak + 2) break;
  }
  return streak;
}

export function lossStreakBlockThreshold(): number {
  return Math.max(1, Number(process.env.AUBOT_PRE_ENTRY_LOSS_STREAK || "2") || 2);
}

/** Horas de pausa según racha (no días). */
export function lossStreakPauseHours(streak: number): number {
  if (streak >= 3) {
    return Math.max(0.5, Number(process.env.AUBOT_LOSS_STREAK_PAUSE_H3 || "2") || 2);
  }
  if (streak >= 2) {
    return Math.max(0.25, Number(process.env.AUBOT_LOSS_STREAK_PAUSE_H2 || "1") || 1);
  }
  return 0;
}

export function isLossStreakPauseActive(): boolean {
  if (!isPsychologyPauseOpen()) return false;
  return /racha\s+\d+\s+p[eé]rdidas/i.test(psychologyPauseReason());
}

function saveRecoveryReport(report: LossStreakRecoveryReport): void {
  try {
    fs.mkdirSync(RECOVERY_DIR, { recursive: true });
    fs.writeFileSync(RECOVERY_FILE, JSON.stringify(report, null, 2));
  } catch {
    /* best effort */
  }
}

export function loadRecoveryReport(): LossStreakRecoveryReport | null {
  try {
    if (!fs.existsSync(RECOVERY_FILE)) return null;
    return JSON.parse(fs.readFileSync(RECOVERY_FILE, "utf8")) as LossStreakRecoveryReport;
  } catch {
    return null;
  }
}

function reviewTrades(trades: ClosedTrade[]): TradeLossReview[] {
  return trades.map((t) => {
    const lesson = buildLessons(t)[0];
    return {
      symbol: t.symbol,
      pnlUsdt: t.pnlUsdt,
      closeReason: t.closeReason,
      entryScore: t.entryScore,
      entryRsi: t.entryRsi,
      lessonEs: lesson?.lessonEs ?? `Pérdida ${t.pnlUsdt.toFixed(4)} USDT`,
    };
  });
}

/** Proyección ~20 min con velas 5m (4 velas). */
export async function simulateEntryForward20m(
  symbol: string,
  entryPrice: number,
): Promise<ForwardSim20m> {
  const c = getConfig();
  const tp = c.takeProfitPct > 0 ? c.takeProfitPct : 3.5;
  const sl = c.stopLossPct > 0 ? c.stopLossPct : 2;
  try {
    const kl = await fetchKlines(symbol, "5m", 6);
    if (kl.length < 3) {
      return {
        symbol,
        entryPrice,
        change20mPct: 0,
        projectedPnlPct: 0,
        verdict: "neutral",
        detailEs: "datos insuficientes para simular 20 min",
      };
    }
    const closes = kl.map((k) => k.close);
    const first = closes[Math.max(0, closes.length - 5)];
    const last = closes[closes.length - 1];
    const change20mPct = first > 0 ? ((last - first) / first) * 100 : 0;
    const projected = ((last * (1 + change20mPct / 200) - entryPrice) / entryPrice) * 100;
    let verdict: ForwardSim20m["verdict"] = "neutral";
    if (projected >= tp * 0.35 && change20mPct > -sl * 0.5) verdict = "favorable";
    else if (projected <= -sl * 0.4 || change20mPct < -sl * 0.6) verdict = "adverse";
    return {
      symbol,
      entryPrice,
      change20mPct: Number(change20mPct.toFixed(3)),
      projectedPnlPct: Number(projected.toFixed(3)),
      verdict,
      detailEs:
        verdict === "favorable"
          ? `tendencia 20m +${change20mPct.toFixed(2)}% — entrada ahora podría alcanzar ~${projected.toFixed(2)}% en ventana corta`
          : verdict === "adverse"
            ? `tendencia 20m ${change20mPct.toFixed(2)}% — entrar ahora seguiría expuesto al stop`
            : `tendencia 20m lateral (${change20mPct.toFixed(2)}%) — esperar confirmación`,
    };
  } catch (e) {
    return {
      symbol,
      entryPrice,
      change20mPct: 0,
      projectedPnlPct: 0,
      verdict: "neutral",
      detailEs: `simulación omitida: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

function buildSummary(
  streak: number,
  pauseH: number,
  reviews: TradeLossReview[],
  sim: ForwardSim20m | null,
  decisionAction: string,
  resumeReady: boolean,
): string {
  const lines: string[] = [];
  if (streak === 1) {
    lines.push("Racha 1 pérdida — ajuste automático sin pausa larga.");
  } else if (pauseH > 0) {
    lines.push(`Racha ${streak} pérdidas — pausa ${pauseH}h + análisis exhaustivo.`);
  }
  for (const r of reviews.slice(0, 3)) {
    lines.push(`· ${r.symbol}: ${r.pnlUsdt >= 0 ? "+" : ""}${r.pnlUsdt.toFixed(2)} USDT — ${r.lessonEs}`);
  }
  if (sim) {
    lines.push(`Simulación 20m: ${sim.detailEs}`);
  }
  lines.push(`Decisión mercado: ${decisionAction}`);
  lines.push(
    resumeReady
      ? "Condiciones para reanudar: OK"
      : "Aún no reanudar — gates macro o simulación desfavorable",
  );
  return lines.join(" ");
}

/** Análisis + ajuste tras cierre perdedor o al detectar racha. */
export async function runLossStreakRecovery(
  streakHint?: number,
  trigger: "close" | "tick" | "manual" = "manual",
): Promise<LossStreakRecoveryReport> {
  if (recoveryRunning) {
    const cached = loadRecoveryReport();
    if (cached) return cached;
  }
  recoveryRunning = true;
  try {
    const streak = streakHint ?? recentLossStreak();
    const threshold = lossStreakBlockThreshold();
    const pauseH = lossStreakPauseHours(streak);
    const recent = [...getClosedTrades(14)].reverse();
    const lossRows: ClosedTrade[] = [];
    for (const t of recent) {
      if ((t.pnlUsdt ?? 0) < 0) lossRows.push(t);
      if (lossRows.length >= Math.max(streak, 1)) break;
    }
    const reviews = reviewTrades(lossRows);

    const free = await getFreeUsdt();
    await runMarketAnalysis(free);
    const learning = await runAutoApplyLearning(14);
    const { evaluateDecision } = await import("./decisionEngine.js");
    const decision = await evaluateDecision();

    let sim: ForwardSim20m | null = null;
    if (streak >= 2 && lossRows.length) {
      const last = lossRows[0];
      sim = await simulateEntryForward20m(last.symbol, last.exitPrice);
    }
    if (streak >= 3 && decision.technical) {
      const sym = String((decision.technical as { symbol?: string }).symbol ?? decision.symbol);
      const price = Number((decision.technical as { price?: number }).price ?? decision.price);
      if (sym && price > 0) {
        sim = await simulateEntryForward20m(sym, price);
      }
    }

    const macroBlocked = decision.action === "BLOCKED";
    const simOk = !sim || sim.verdict !== "adverse";
    const resumeReady =
      streak < threshold ||
      (!isPsychologyPauseOpen() &&
        decision.action === "ENTER_CANDIDATE" &&
        simOk) ||
      (!macroBlocked && sim?.verdict === "favorable" && streak >= 3);

    if (streak >= threshold && pauseH > 0 && trigger !== "tick") {
      if (!isLossStreakPauseActive() || streak > lastRecoveryStreak) {
        openPsychologyPause(
          pauseH,
          `racha ${streak} pérdidas — pausa ${pauseH}h (análisis automático)`,
          false,
        );
        lastRecoveryStreak = streak;
      }
    }

    if (resumeReady && isLossStreakPauseActive() && trigger === "tick") {
      clearPsychologyPause();
      lastRecoveryStreak = 0;
      pushLog("info", `lossStreakRecovery: pausa levantada — mercado OK tras análisis`);
    }

    const report: LossStreakRecoveryReport = {
      at: new Date().toISOString(),
      streak,
      pauseHours: pauseH,
      paused: isLossStreakPauseActive(),
      tradeReviews: reviews,
      simulation: sim,
      learningApplied: Boolean(learning.applied),
      decisionAction: decision.action,
      resumeReady,
      summaryEs: buildSummary(streak, pauseH, reviews, sim, decision.action, resumeReady),
    };
    saveRecoveryReport(report);
    pushLog(
      "info",
      `lossStreakRecovery s=${streak} pause=${pauseH}h trigger=${trigger} resume=${resumeReady}`,
    );
    return report;
  } finally {
    recoveryRunning = false;
  }
}

/** Al cerrar en pérdida — dispara recuperación según racha. */
export async function handleLossOnClose(closed: ClosedTrade): Promise<void> {
  if ((closed.pnlUsdt ?? 0) >= 0) {
    if (isLossStreakPauseActive()) clearPsychologyPause();
    lastRecoveryStreak = 0;
    return;
  }
  const streak = recentLossStreak();
  await runLossStreakRecovery(streak, "close");
}

/** Tick del motor — al vencer pausa, re-analiza y reanuda si procede. */
export async function maybeRunLossStreakRecoveryTick(): Promise<void> {
  if (!isLossStreakPauseActive()) return;
  const streak = recentLossStreak();
  if (streak < lossStreakBlockThreshold()) {
    clearPsychologyPause();
    return;
  }
  await runLossStreakRecovery(streak, "tick");
}
