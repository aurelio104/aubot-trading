import { describe, it, expect } from "vitest";
import { longRegimeAllowed, longRegimeGateEnabled } from "./marketRegime.js";

describe("marketRegime", () => {
  it("longRegimeAllowed solo en BULL y NEUTRAL", () => {
    expect(longRegimeAllowed("BULL")).toBe(true);
    expect(longRegimeAllowed("NEUTRAL")).toBe(true);
    expect(longRegimeAllowed("BEAR")).toBe(false);
    expect(longRegimeAllowed(null)).toBe(false);
  });

  it("longRegimeGateEnabled por defecto true", () => {
    const prev = process.env.AUBOT_LONG_REGIME_GATE;
    delete process.env.AUBOT_LONG_REGIME_GATE;
    expect(longRegimeGateEnabled()).toBe(true);
    process.env.AUBOT_LONG_REGIME_GATE = prev;
  });
});
