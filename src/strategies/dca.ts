import { getConfig } from "../config.js";
import { qtyFromQuoteUsdt } from "../binance.js";
import { executeBuy } from "../risk.js";

let lastDcaAt = 0;

export async function runDCA(price: number): Promise<void> {
  const c = getConfig();
  const now = Date.now();
  if (now - lastDcaAt < c.dcaIntervalMs) return;

  const qty = qtyFromQuoteUsdt(c.dcaQuoteUsdt, price);
  const ok = await executeBuy(
    c.symbol,
    qty,
    price,
    `dca ${c.dcaQuoteUsdt} USDT`,
  );
  if (ok) lastDcaAt = now;
}

export function resetDcaTimer(): void {
  lastDcaAt = 0;
}
