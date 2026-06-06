/** Formato y validación RSI para display y gates. */
export function normalizeRsi(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return 50;
  return Math.round(value * 10) / 10;
}

/** RSI < 12 suele ser cuchillo o dato insuficiente — no usar para entrada. */
export function rsiExtremeLow(r: number): boolean {
  return Number.isFinite(r) && r < 12;
}

export function formatRsiLabel(r: number): string {
  const n = normalizeRsi(r);
  if (rsiExtremeLow(n)) return `${n} (extremo — esperar rebote)`;
  return String(n);
}
