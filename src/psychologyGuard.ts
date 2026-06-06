/**
 * Métricas psicológicas / disciplina — informativo; NO bloquea entradas (lo decide /decision).
 */
import { computeScorecard } from "./tradeLedger.js";
import { preEntryLossStreakBlocked } from "./smartCapital.js";
import {
  isCircuitOpen,
  circuitOpenReason,
  isPsychologyPauseOpen,
  psychologyPauseReason,
} from "./runtimeConfig.js";

export type PsychologySeverity = "OK" | "CAUTION" | "CRITICAL";

export interface PsychologySnapshot {
  enabled: boolean;
  severity: PsychologySeverity;
  criticalPause: boolean;
  lossStreakPause: boolean;
  circuitPause: boolean;
  manualPause: boolean;
  reasons: string[];
  reason: string;
  recommendedAction: string;
  hideTemptationSignals: boolean;
  trades: number;
  wins: number;
  winRatePct: number;
  freeUsdt: number;
}

export function psychologyGuardEnabled(): boolean {
  return process.env.AUBOT_PSYCHOLOGY_GUARD !== "false";
}

export function evaluatePsychologyGuard(freeUsdt: number): PsychologySnapshot {
  const empty: PsychologySnapshot = {
    enabled: false,
    severity: "OK",
    criticalPause: false,
    lossStreakPause: false,
    circuitPause: false,
    manualPause: false,
    reasons: [],
    reason: "",
    recommendedAction: "Si /decision = ENTER_CANDIDATE → operación REAL con capital actual",
    hideTemptationSignals: false,
    trades: 0,
    wins: 0,
    winRatePct: 0,
    freeUsdt,
  };
  if (!psychologyGuardEnabled()) return empty;

  const sc = computeScorecard(30);
  const reasons: string[] = [];
  let severity: PsychologySeverity = "OK";

  const lossGate = preEntryLossStreakBlocked();
  const circuit = isCircuitOpen();
  const manual = isPsychologyPauseOpen();

  if (lossGate.blocked) {
    reasons.push(lossGate.reason);
    severity = "CAUTION";
  }
  if (circuit) {
    reasons.push(circuitOpenReason());
    severity = "CAUTION";
  }
  if (manual) {
    reasons.push(psychologyPauseReason());
    severity = "CAUTION";
  }

  if (freeUsdt > 0) {
    reasons.push(`capital operativo ${freeUsdt.toFixed(2)} USDT — trades REALES si /decision OK`);
  }

  return {
    enabled: true,
    severity,
    criticalPause: false,
    lossStreakPause: lossGate.blocked,
    circuitPause: circuit,
    manualPause: manual,
    reasons,
    reason: reasons[0] || "",
    recommendedAction:
      "Entrada solo vía /decision = ENTER_CANDIDATE (checklist + gates técnicos)",
    hideTemptationSignals: false,
    trades: sc.trades,
    wins: sc.wins,
    winRatePct: sc.winRatePct,
    freeUsdt,
  };
}

export function maskOpportunityIfPaused<T extends { signal?: string; reason?: string }>(
  row: T | null | undefined,
  _psych: PsychologySnapshot,
): T | null | undefined {
  return row;
}
