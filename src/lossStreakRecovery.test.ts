import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  lossStreakPauseHours,
  lossStreakBlockThreshold,
} from "./lossStreakRecovery.js";

describe("lossStreakRecovery", () => {
  const env = process.env;

  beforeEach(() => {
    process.env = { ...env };
  });

  afterEach(() => {
    process.env = env;
  });

  it("pausa 0h en racha 1", () => {
    expect(lossStreakPauseHours(1)).toBe(0);
  });

  it("pausa 1h en racha 2 por defecto", () => {
    expect(lossStreakPauseHours(2)).toBe(1);
  });

  it("pausa 2h en racha 3+ por defecto", () => {
    expect(lossStreakPauseHours(3)).toBe(2);
    expect(lossStreakPauseHours(5)).toBe(2);
  });

  it("respeta env AUBOT_LOSS_STREAK_PAUSE_H2/H3", () => {
    process.env.AUBOT_LOSS_STREAK_PAUSE_H2 = "0.5";
    process.env.AUBOT_LOSS_STREAK_PAUSE_H3 = "1.5";
    expect(lossStreakPauseHours(2)).toBe(0.5);
    expect(lossStreakPauseHours(4)).toBe(1.5);
  });

  it("bloqueo desde racha 2 por defecto", () => {
    expect(lossStreakBlockThreshold()).toBe(2);
  });
});
