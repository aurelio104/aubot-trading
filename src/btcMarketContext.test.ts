import { describe, it, expect, afterEach } from "vitest";
import {
  unifiedEntryBlocked,
  unifiedBtcGatesEnabled,
  type BtcMarketSnapshot,
} from "./btcMarketContext.js";

describe("btcMarketContext", () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it("unifiedBtcGatesEnabled por defecto true", () => {
    delete process.env.AUBOT_UNIFIED_BTC_GATES;
    expect(unifiedBtcGatesEnabled()).toBe(true);
  });

  it("bloquea entradas con miedo extremo en todos los pares", () => {
    const snap: Pick<
      BtcMarketSnapshot,
      "blockAllEntries" | "extremeFear" | "longAllowed" | "regime"
    > = {
      blockAllEntries: true,
      extremeFear: true,
      longAllowed: false,
      regime: "BEAR",
    };
    expect(unifiedEntryBlocked(snap)).toBe(true);
  });

  it("bloquea LONG en régimen BEAR", () => {
    process.env.AUBOT_BLOCK_ENTRY_BEAR = "true";
    process.env.AUBOT_LONG_REGIME_GATE = "true";
    const snap: Pick<
      BtcMarketSnapshot,
      "blockAllEntries" | "extremeFear" | "longAllowed" | "regime"
    > = {
      blockAllEntries: false,
      extremeFear: false,
      longAllowed: false,
      regime: "BEAR",
    };
    expect(unifiedEntryBlocked(snap)).toBe(true);
  });

  it("permite evaluación en BULL sin bloqueo global", () => {
    const snap: Pick<
      BtcMarketSnapshot,
      "blockAllEntries" | "extremeFear" | "longAllowed" | "regime"
    > = {
      blockAllEntries: false,
      extremeFear: false,
      longAllowed: true,
      regime: "BULL",
    };
    expect(unifiedEntryBlocked(snap)).toBe(false);
  });
});
