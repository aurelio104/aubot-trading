export type StrategyName =
  | "threshold"
  | "dca"
  | "mean_reversion"
  | "grid";

export interface AppConfig {
  symbol: string;
  autoTrade: boolean;
  strategy: StrategyName;
  tradeQty: string;
  tickMs: number;
  cooldownMs: number;
  buyBelow: number;
  sellAbove: number;
  trailingStopPct: number;
  stopLossPct: number;
  takeProfitPct: number;
  maxTradesPerDay: number;
  maxDailyLossUsdt: number;
  maxPositionUsdt: number;
  dcaIntervalMs: number;
  dcaQuoteUsdt: number;
  klineInterval: string;
  rsiPeriod: number;
  rsiBuyBelow: number;
  rsiSellAbove: number;
  bbPeriod: number;
  bbStdDev: number;
  gridLower: number;
  gridUpper: number;
  gridLevels: number;
  gridSpacing: "arithmetic" | "geometric";
  gridStopLossPct: number;
  gridInvestmentUsdt: number;
  gridStatePath: string;
  capitalMode: boolean;
  capitalPct: number;
  reserveUsdt: number;
  minNotionalUsdt: number;
  useQuoteOrderQty: boolean;
  candidateSymbols: string[];
  autoPickSymbol: boolean;
  analysisIntervalMs: number;
  symbolSwitchScoreDelta: number;
}

function num(key: string, fallback: number): number {
  const v = Number(process.env[key] ?? "");
  return Number.isFinite(v) ? v : fallback;
}

export function loadConfig(): AppConfig {
  const strategy = (process.env.AUBOT_STRATEGY || "threshold") as StrategyName;
  const spacing = process.env.AUBOT_GRID_SPACING === "geometric"
    ? "geometric"
    : "arithmetic";

  return {
    symbol: process.env.AUBOT_SYMBOL || "BTCUSDT",
    autoTrade: process.env.AUBOT_AUTO_TRADE === "true",
    strategy,
    tradeQty: process.env.AUBOT_TRADE_QTY || "0.001",
    tickMs: Math.max(250, num("AUBOT_TICK_MS", 1000)),
    cooldownMs: Math.max(1000, num("AUBOT_COOLDOWN_MS", 60_000)),
    buyBelow: num("AUBOT_BUY_BELOW", 0),
    sellAbove: num("AUBOT_SELL_ABOVE", 0),
    trailingStopPct: num("AUBOT_TRAILING_STOP_PCT", 0),
    stopLossPct: num("AUBOT_STOP_LOSS_PCT", 0),
    takeProfitPct: num("AUBOT_TAKE_PROFIT_PCT", 0),
    maxTradesPerDay: Math.max(0, num("AUBOT_MAX_TRADES_PER_DAY", 0)),
    maxDailyLossUsdt: num("AUBOT_MAX_DAILY_LOSS_USDT", 0),
    maxPositionUsdt: num("AUBOT_MAX_POSITION_USDT", 0),
    dcaIntervalMs: Math.max(60_000, num("AUBOT_DCA_INTERVAL_MS", 3_600_000)),
    dcaQuoteUsdt: num("AUBOT_DCA_QUOTE_USDT", 20),
    klineInterval: process.env.AUBOT_KLINE_INTERVAL || "15m",
    rsiPeriod: Math.max(2, num("AUBOT_RSI_PERIOD", 14)),
    rsiBuyBelow: num("AUBOT_RSI_BUY_BELOW", 30),
    rsiSellAbove: num("AUBOT_RSI_SELL_ABOVE", 70),
    bbPeriod: Math.max(5, num("AUBOT_BB_PERIOD", 20)),
    bbStdDev: num("AUBOT_BB_STDDEV", 2),
    gridLower: num("AUBOT_GRID_LOWER", 0),
    gridUpper: num("AUBOT_GRID_UPPER", 0),
    gridLevels: Math.max(2, num("AUBOT_GRID_LEVELS", 10)),
    gridSpacing: spacing,
    gridStopLossPct: num("AUBOT_GRID_STOP_LOSS_PCT", 8),
    gridInvestmentUsdt: num("AUBOT_GRID_INVESTMENT_USDT", 500),
    gridStatePath:
      process.env.AUBOT_GRID_STATE_PATH || "/tmp/aubot-grid-state.json",
    capitalMode: process.env.AUBOT_CAPITAL_MODE === "true",
    capitalPct: num("AUBOT_CAPITAL_PCT", 88),
    reserveUsdt: num("AUBOT_RESERVE_USDT", 2),
    minNotionalUsdt: num("AUBOT_MIN_NOTIONAL_USDT", 5),
    useQuoteOrderQty: process.env.AUBOT_USE_QUOTE_ORDER_QTY !== "false",
    candidateSymbols: (process.env.AUBOT_CANDIDATE_SYMBOLS ||
      "ETHUSDT;SOLUSDT;BNBUSDT;XRPUSDT;DOGEUSDT;ADAUSDT;LINKUSDT")
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter(Boolean),
    autoPickSymbol: process.env.AUBOT_AUTO_PICK_SYMBOL !== "false",
    analysisIntervalMs: Math.max(
      60_000,
      num("AUBOT_ANALYSIS_INTERVAL_MS", 300_000),
    ),
    symbolSwitchScoreDelta: num("AUBOT_SYMBOL_SWITCH_DELTA", 8),
  };
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

export function strategyConfigPublic() {
  const c = getConfig();
  return {
    autoTrade: c.autoTrade,
    strategy: c.strategy,
    symbol: c.symbol,
    tradeQty: c.tradeQty,
    buyBelow: c.buyBelow || null,
    sellAbove: c.sellAbove || null,
    trailingStopPct: c.trailingStopPct || null,
    stopLossPct: c.stopLossPct || null,
    takeProfitPct: c.takeProfitPct || null,
    maxTradesPerDay: c.maxTradesPerDay || null,
    maxDailyLossUsdt: c.maxDailyLossUsdt || null,
    dcaIntervalMs: c.dcaIntervalMs,
    dcaQuoteUsdt: c.dcaQuoteUsdt,
    klineInterval: c.klineInterval,
    rsiBuyBelow: c.rsiBuyBelow,
    rsiSellAbove: c.rsiSellAbove,
    gridLower: c.gridLower || null,
    gridUpper: c.gridUpper || null,
    gridLevels: c.gridLevels,
    capitalMode: c.capitalMode,
    capitalPct: c.capitalPct,
    reserveUsdt: c.reserveUsdt,
    candidateSymbols: c.candidateSymbols,
    autoPickSymbol: c.autoPickSymbol,
  };
}
