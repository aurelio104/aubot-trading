import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { resetConfigCache } from "./config.js";
import {
  buildAdaptiveCandidatePlan,
  resolveCapitalTier,
  isBtcTradable,
  autoExpandSymbolsEnabled,
} from "./adaptiveCandidates.js";

describe("adaptiveCandidates", () => {
  const envBackup = { ...process.env };

  beforeEach(() => resetConfigCache());
  afterEach(() => {
    process.env = { ...envBackup };
    resetConfigCache();
  });

  it("autoExpand habilitado por defecto", () => {
    delete process.env.AUBOT_AUTO_EXPAND_SYMBOLS;
    expect(autoExpandSymbolsEnabled()).toBe(true);
  });

  it("capital ~21 USDT → tier micro/small, BTC no tradable", () => {
    process.env.AUBOT_CAPITAL_MODE = "true";
    process.env.AUBOT_CAPITAL_PCT = "80";
    process.env.AUBOT_RESERVE_USDT = "3";
    const plan = buildAdaptiveCandidatePlan(21);
    expect(plan.btcTradable).toBe(false);
    expect(plan.tradableSymbols).not.toContain("BTCUSDT");
    expect(plan.analysisSymbols[0]).toBe("BTCUSDT");
    expect(plan.tradableSymbols.length).toBeGreaterThanOrEqual(3);
  });

  it("capital ~1000 USDT → tier full/large, BTC tradable", () => {
    process.env.AUBOT_CAPITAL_MODE = "true";
    process.env.AUBOT_CAPITAL_PCT = "80";
    process.env.AUBOT_RESERVE_USDT = "3";
    process.env.AUBOT_TIER_BTC_USDT = "400";
    const plan = buildAdaptiveCandidatePlan(1000);
    expect(isBtcTradable(1000, 500)).toBe(true);
    expect(plan.btcTradable).toBe(true);
    expect(plan.tradableSymbols).toContain("BTCUSDT");
    expect(plan.expandedCount).toBeGreaterThan(plan.baseCount);
  });

  it("mismo tier lógico escala con capital", () => {
    expect(resolveCapitalTier(21, 14)).toBe("micro");
    expect(resolveCapitalTier(100, 60)).toBe("mid");
    expect(resolveCapitalTier(1000, 600)).toBe("full");
  });
});
