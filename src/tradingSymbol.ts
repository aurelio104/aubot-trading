import { getConfig } from "./config.js";
import { closePosition } from "./position.js";

let activeSymbol: string | null = null;

export function getTradingSymbol(): string {
  return activeSymbol || getConfig().symbol;
}

export function setTradingSymbol(symbol: string): void {
  const next = symbol.toUpperCase();
  if (activeSymbol && activeSymbol !== next) {
    closePosition();
  }
  activeSymbol = next;
}
