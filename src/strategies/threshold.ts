import { getConfig } from "../config.js";
import { hasOpenPosition } from "../position.js";
import { executeBuy, executeSell } from "../risk.js";

export async function runThreshold(price: number): Promise<void> {
  const c = getConfig();
  if (c.buyBelow <= 0 && c.sellAbove <= 0) return;

  if (c.buyBelow > 0 && price < c.buyBelow && !hasOpenPosition()) {
    await executeBuy(c.symbol, c.tradeQty, price, `threshold < ${c.buyBelow}`);
    return;
  }
  if (c.sellAbove > 0 && price > c.sellAbove && hasOpenPosition()) {
    const pos = await import("../position.js");
    const p = pos.getPosition();
    const qty = p ? String(p.quantity) : c.tradeQty;
    await executeSell(c.symbol, qty, price, `threshold > ${c.sellAbove}`);
  }
}
