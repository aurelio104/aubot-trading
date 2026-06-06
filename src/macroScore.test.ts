import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  buildMacroScoreContext,
  macroScorePenalty,
  enrichCandidatesWithMacro,
} from "./macroScore.js";
import type { SymbolOpportunity } from "./marketAnalysis.js";

describe("macroScore", () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it("penaliza régimen BEAR y F&G extremo", () => {
    const ctx = buildMacroScoreContext(
      {
        at: "",
        enabled: true,
        fearGreed: 12,
        fearGreedLabel: "Extreme Fear",
        btcSentiment: -35,
        maxImpact: "MED",
        blockAllEntries: true,
        blockUntil: null,
        minScoreBoost: 15,
        blockedSymbols: [],
        macroWindow: true,
        gateReason: "test",
        headlines: [],
        summaryEs: "",
      },
      {
        at: "",
        regime: "BEAR",
        btcChange4hPct: -2.1,
        strongBuyCount: 0,
        sellCount: 4,
        minEnterScore: 85,
        reason: "bear",
      },
    );
    const penalty = macroScorePenalty(ctx);
    expect(penalty).toBeGreaterThanOrEqual(28);
  });

  it("degrada strong_buy a hold con penalización alta", () => {
    const candidates: SymbolOpportunity[] = [
      {
        symbol: "SOLUSDT",
        price: 100,
        rsi: 28,
        distToBbLowerPct: -1,
        buyScore: 75,
        signal: "strong_buy",
        affordable: true,
        quoteUsdt: 15,
        projectedProfitPct: 3,
        projectedProfitUsdt: 0.45,
        projectedLossUsdt: 0.22,
        etaHoursMin: 1,
        etaHoursMax: 4,
        reason: "test",
      },
    ];
    enrichCandidatesWithMacro(
      candidates,
      {
        at: "",
        enabled: true,
        fearGreed: 12,
        fearGreedLabel: "Extreme Fear",
        btcSentiment: -40,
        maxImpact: "HIGH",
        blockAllEntries: true,
        blockUntil: null,
        minScoreBoost: 15,
        blockedSymbols: [],
        macroWindow: true,
        gateReason: "crash",
        headlines: [],
        summaryEs: "",
      },
      {
        at: "",
        regime: "BEAR",
        btcChange4hPct: -3,
        strongBuyCount: 0,
        sellCount: 5,
        minEnterScore: 85,
        reason: "bear",
      },
    );
    expect(candidates[0].buyScore).toBeLessThan(75);
    expect(candidates[0].macroPenalty).toBeGreaterThan(0);
    expect(["hold", "buy"]).toContain(candidates[0].signal);
  });
});
