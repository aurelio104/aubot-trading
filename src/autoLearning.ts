/**
 * Aprendizaje automático post-cierre: scorecard → ajuste params → blacklist → WR por par.
 */
import { pushLog } from "./log.js";
import {
  addExcludedSymbol,
  patchStrategyParams,
} from "./runtimeConfig.js";
import { minGrossTpPct } from "./capitalRules.js";
import { applyLearningFromScorecard } from "./syncBinanceTrades.js";
import { computeScorecard, type ClosedTrade } from "./tradeLedger.js";
import { updatePairWrFromScorecard } from "./pairWrStore.js";

export function autoApplyLearningEnabled(): boolean {
  return process.env.AUBOT_AUTO_APPLY_LEARNING !== "false";
}

export async function runAutoApplyLearning(days = 30): Promise<Record<string, unknown>> {
  const scorecard = computeScorecard(days);
  const learning = await applyLearningFromScorecard(scorecard);

  if (!autoApplyLearningEnabled()) {
    return { ...learning, applied: false, reason: "AUBOT_AUTO_APPLY_LEARNING=false" };
  }

  const patched = patchStrategyParams({
    rsiBuyBelow:
      learning.suggestedRsiBuyBelow != null
        ? Number(learning.suggestedRsiBuyBelow)
        : undefined,
    takeProfitPct:
      learning.suggestedTakeProfitPct != null
        ? Math.max(Number(learning.suggestedTakeProfitPct), minGrossTpPct())
        : undefined,
    stopLossPct:
      learning.suggestedStopLossPct != null
        ? Number(learning.suggestedStopLossPct)
        : undefined,
    capitalPct:
      learning.suggestedCapitalPct != null
        ? Number(learning.suggestedCapitalPct)
        : undefined,
  });

  if (learning.blacklistCandidate) {
    addExcludedSymbol(String(learning.blacklistCandidate));
    pushLog("info", `autoLearning blacklist +${learning.blacklistCandidate}`);
  }

  const pairWr = updatePairWrFromScorecard(scorecard, days);

  pushLog(
    "info",
    `autoLearning aplicado WR=${scorecard.winRatePct}% TP=${patched.takeProfitPct}% SL=${patched.stopLossPct}% capital=${patched.capitalPct}%`,
  );

  return {
    ...learning,
    applied: true,
    scorecard,
    strategyParams: patched,
    pairWrUpdated: pairWr.pairs.length,
    at: new Date().toISOString(),
  };
}

export async function runAutoLearningAfterClose(
  closed?: ClosedTrade | null,
  days = 30,
): Promise<Record<string, unknown>> {
  if (closed && (closed.pnlUsdt ?? 0) < 0) {
    const { handleLossOnClose } = await import("./lossStreakRecovery.js");
    await handleLossOnClose(closed).catch((e) => {
      pushLog(
        "warn",
        `lossStreakRecovery: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }
  const result = await runAutoApplyLearning(days);
  if (closed) {
    pushLog(
      "info",
      `autoLearning post-cierre ${closed.symbol} net=${closed.pnlUsdt >= 0 ? "+" : ""}${closed.pnlUsdt.toFixed(4)} USDT`,
    );
  }
  return result;
}
