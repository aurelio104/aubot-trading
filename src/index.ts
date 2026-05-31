import type { FastifyRequest } from "fastify";
import Fastify from "fastify";
import {
  binanceBaseUrl,
  createMarketBuyQuote,
  createMarketOrder,
  fetchTickerPrice,
  getAccountBalances,
  getAllWallets,
  getOpenOrders,
  hasCredentials,
  universalTransfer,
  type TransferType,
} from "./binance.js";
import {
  getStatus,
  maybeAutoStart,
  pauseEngine,
  startEngine,
  stopEngine,
} from "./engine.js";
import { getLogs, pushLog } from "./log.js";
import {
  analyzeRotation,
  getCurrentPrice,
  getStats,
  maybeRotateOnBetterOpportunity,
  refreshAnalysis,
  strategyConfig,
} from "./strategy.js";
import {
  closePosition,
  openLong,
  initPositionFromStore,
  setPositionPersistHook,
} from "./position.js";
import {
  loadPersistedPosition,
  persistPosition,
} from "./positionStore.js";
import {
  patchStrategyParams,
  setExcludedSymbols,
  getExcludedSymbols,
  setBlockedHoursUtc,
  initDefaultBlacklist,
  addExcludedSymbol,
} from "./runtimeConfig.js";
import {
  detectMarketRegime,
  getCachedRegime,
  marketRegimeEnabled,
} from "./marketRegime.js";
import {
  ensureNewsContext,
  getCachedNews,
  newsContextEnabled,
  refreshNewsContext,
} from "./newsContext.js";
import { evaluateDecision } from "./decisionEngine.js";
import { syncPositionFromBalances } from "./syncPosition.js";
import { setTradingSymbol } from "./tradingSymbol.js";
import {
  consolidateEnabled,
  consolidateToUsdt,
} from "./consolidateUsdt.js";
import { ensureSpotNotEarn, earnProtectionEnabled } from "./simpleEarn.js";
import {
  computeScorecard,
  getClosedTrades,
  getLastClosedTrade,
  getLessons,
  initTradeLedger,
} from "./tradeLedger.js";
import {
  applyLearningFromScorecard,
  syncTradesFromBinance,
} from "./syncBinanceTrades.js";

const port = Number(process.env.PORT || "8080");
const host = process.env.HOST || "0.0.0.0";
const controlToken = process.env.AUBOT_CONTROL_TOKEN || "";
const defaultSymbol = process.env.AUBOT_SYMBOL || "BTCUSDT";

const app = Fastify({ logger: true });

function controlAuthorized(req: FastifyRequest): boolean {
  if (!controlToken) return true;
  const header =
    (req.headers["x-aubot-token"] as string | undefined) ||
    req.headers.authorization?.replace(/^Bearer\s+/i, "");
  return header === controlToken;
}

app.get("/stats", async () => getStats());

app.get("/health", async () => ({
  ok: true,
  service: "aubot-trading",
  binance: binanceBaseUrl(),
  credentials: hasCredentials(),
  testnet: process.env.BINANCE_TESTNET !== "false",
}));

app.get("/status", async () => ({
  ...getStatus(),
  strategy: await strategyConfig(),
  credentials: hasCredentials(),
}));

app.get("/analysis", async (_req, reply) => {
  if (!hasCredentials()) {
    return reply.code(503).send({ error: "BINANCE credentials not configured" });
  }
  const analysis = await refreshAnalysis();
  const regime =
    marketRegimeEnabled() ? await detectMarketRegime(analysis) : null;
  return { ...analysis, regime };
});

app.get("/regime", async (_req, reply) => {
  if (!hasCredentials()) {
    return reply.code(503).send({ error: "BINANCE credentials not configured" });
  }
  if (!marketRegimeEnabled()) {
    return { enabled: false, regime: null };
  }
  const cached = getCachedRegime();
  const regime = cached ?? (await detectMarketRegime());
  return { enabled: true, ...regime };
});

app.get("/news", async () => {
  if (!newsContextEnabled()) {
    return { enabled: false, news: null };
  }
  const news = (await ensureNewsContext()) ?? getCachedNews();
  if (!news) {
    return {
      enabled: true,
      at: new Date().toISOString(),
      summaryEs: "sin datos",
      headlines: [],
      blockAllEntries: false,
      minScoreBoost: 0,
    };
  }
  const { enabled: _omit, ...rest } = news;
  return { enabled: true, ...rest };
});

app.get("/decision", async (_req, reply) => {
  if (!hasCredentials()) {
    return reply.code(503).send({ error: "BINANCE credentials not configured" });
  }
  const decision = await evaluateDecision();
  return decision;
});

app.get<{ Querystring: { limit?: string } }>("/logs", async (req) => {
  const limit = Number(req.query.limit || "50") || 50;
  return { logs: getLogs(limit) };
});

app.get<{ Querystring: { days?: string; limit?: string } }>(
  "/trades",
  async (req, reply) => {
    if (!hasCredentials()) {
      return reply.code(503).send({ error: "BINANCE credentials not configured" });
    }
    const days = Number(req.query.days || "30") || 30;
    const limit = Number(req.query.limit || "100") || 100;
    const trades = getClosedTrades(days).slice(-limit);
    return {
      at: new Date().toISOString(),
      days,
      count: trades.length,
      trades,
      last: getLastClosedTrade(),
    };
  },
);

app.get<{ Querystring: { days?: string } }>("/scorecard", async (req, reply) => {
  if (!hasCredentials()) {
    return reply.code(503).send({ error: "BINANCE credentials not configured" });
  }
  const days = Number(req.query.days || "30") || 30;
  const scorecard = computeScorecard(days);
  const learning = await applyLearningFromScorecard(scorecard);
  return { scorecard, learning, lessons: getLessons(10) };
});

app.get<{ Querystring: { limit?: string } }>("/lecciones", async (req) => {
  const limit = Number(req.query.limit || "30") || 30;
  return { at: new Date().toISOString(), lessons: getLessons(limit) };
});

app.get("/account", async (_req, reply) => {
  if (!hasCredentials()) {
    return reply.code(503).send({ error: "BINANCE credentials not configured" });
  }
  const balances = await getAccountBalances();
  return { balances, testnet: process.env.BINANCE_TESTNET !== "false" };
});

app.get("/wallets", async (_req, reply) => {
  if (!hasCredentials()) {
    return reply.code(503).send({ error: "BINANCE credentials not configured" });
  }
  return getAllWallets();
});

app.post("/consolidate", async (req, reply) => {
  if (!controlAuthorized(req)) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  if (!hasCredentials()) {
    return reply.code(503).send({ error: "BINANCE credentials not configured" });
  }
  pushLog("info", "manual consolidate → USDT Spot");
  const result = await consolidateToUsdt();
  closePosition();
  return { ok: true, ...result };
});

app.post("/earn/redeem", async (req, reply) => {
  if (!controlAuthorized(req)) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  if (!hasCredentials()) {
    return reply.code(503).send({ error: "BINANCE credentials not configured" });
  }
  if (!earnProtectionEnabled()) {
    return reply.code(400).send({ error: "AUBOT_KEEP_SPOT=false — protección Earn desactivada" });
  }
  pushLog("info", "manual earn redeem → Spot");
  const result = await ensureSpotNotEarn();
  return { ok: true, ...result };
});

app.get<{ Querystring: { symbol?: string } }>("/price", async (req, reply) => {
  const symbol = req.query.symbol || defaultSymbol;
  try {
    const price = await fetchTickerPrice(symbol);
    return { symbol, price, at: new Date().toISOString() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(502).send({ error: msg });
  }
});

app.post<{
  Body: { type?: string; asset?: string; amount?: string };
}>("/transfer", async (req, reply) => {
  if (!controlAuthorized(req)) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  if (!hasCredentials()) {
    return reply.code(503).send({ error: "BINANCE credentials not configured" });
  }
  const type = req.body?.type as TransferType | undefined;
  const asset = (req.body?.asset || "USDT").toUpperCase();
  const amount = req.body?.amount;
  if (type !== "MAIN_FUNDING" && type !== "FUNDING_MAIN") {
    return reply.code(400).send({
      error: "type: MAIN_FUNDING (spot→fondos) | FUNDING_MAIN (fondos→spot)",
    });
  }
  if (!amount || Number(amount) <= 0) {
    return reply.code(400).send({ error: "amount required" });
  }
  pushLog("info", `transfer ${type} ${amount} ${asset}`);
  const result = await universalTransfer(type, asset, amount);
  return { ok: true, ...result };
});

app.get<{ Querystring: { symbol?: string } }>("/orders", async (req, reply) => {
  if (!hasCredentials()) {
    return reply.code(503).send({ error: "BINANCE credentials not configured" });
  }
  const orders = await getOpenOrders(req.query.symbol || defaultSymbol);
  return { orders };
});

app.post<{
  Body: { action?: string; symbol?: string; side?: string; quantity?: string };
}>("/control", async (req, reply) => {
  if (!controlAuthorized(req)) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  const action = req.body?.action;
  if (action === "start") startEngine();
  else if (action === "stop") stopEngine();
  else if (action === "pause") pauseEngine();
  else if (action === "sync_position") {
    const symbol = req.body?.symbol || defaultSymbol;
    const result = await syncPositionFromBalances(symbol);
    return { ...getStatus(), sync: result };
  } else if (action === "refresh_analysis") {
    const analysis = await refreshAnalysis();
    return { ...getStatus(), analysis };
  } else if (action === "redeem_earn") {
    const result = await ensureSpotNotEarn();
    return { ...getStatus(), earn: result };
  } else if (action === "consolidate_usdt") {
    const result = await consolidateToUsdt();
    closePosition();
    return { ...getStatus(), consolidate: result };
  } else if (action === "set_symbol") {
    const symbol = (req.body?.symbol || defaultSymbol).toUpperCase();
    setTradingSymbol(symbol);
    pushLog("info", `control set_symbol ${symbol}`);
    return { ...getStatus(), symbol };
  } else if (action === "analyze_rotation") {
    const price = await getCurrentPrice();
    const rotation = await analyzeRotation(price);
    return { ...getStatus(), rotation };
  } else if (action === "rotate_if_better") {
    const price = await getCurrentPrice();
    const before = await analyzeRotation(price);
    const done = await maybeRotateOnBetterOpportunity(price, true);
    return { ...getStatus(), rotation: before, rotated: done };
  } else if (action === "set_strategy_params") {
    const body = req.body as Record<string, unknown>;
    const patched = patchStrategyParams({
      rsiBuyBelow:
        body.rsiBuyBelow != null ? Number(body.rsiBuyBelow) : undefined,
      rsiSellAbove:
        body.rsiSellAbove != null ? Number(body.rsiSellAbove) : undefined,
      takeProfitPct:
        body.takeProfitPct != null ? Number(body.takeProfitPct) : undefined,
      stopLossPct:
        body.stopLossPct != null ? Number(body.stopLossPct) : undefined,
      capitalPct: body.capitalPct != null ? Number(body.capitalPct) : undefined,
    });
    pushLog("info", `control set_strategy_params RSI=${patched.rsiBuyBelow} TP=${patched.takeProfitPct}%`);
    return { ...getStatus(), strategyParams: patched };
  } else if (action === "set_blacklist") {
    const body = req.body as { symbols?: string[] };
    const symbols = Array.isArray(body.symbols) ? body.symbols : [];
    setExcludedSymbols(symbols.map((s) => String(s).toUpperCase()));
    pushLog("info", `control set_blacklist ${getExcludedSymbols().join(",")}`);
    return { ...getStatus(), blacklist: getExcludedSymbols() };
  } else if (action === "set_blocked_hours") {
    const body = req.body as { hours?: number[] };
    const hours = Array.isArray(body.hours)
      ? body.hours.map((h) => Number(h)).filter((h) => h >= 0 && h <= 23)
      : [];
    setBlockedHoursUtc(hours);
    pushLog("info", `control set_blocked_hours ${hours.join(",")}`);
    return { ...getStatus(), blockedHoursUtc: hours };
  } else if (action === "refresh_news") {
    const news = await refreshNewsContext();
    return { ...getStatus(), news };
  } else if (action === "sync_trades") {
    const days = Number((req.body as { days?: number })?.days || 30) || 30;
    const result = await syncTradesFromBinance(days);
    const scorecard = computeScorecard(days);
    const learning = await applyLearningFromScorecard(scorecard);
    return { ...getStatus(), syncTrades: result, scorecard, learning };
  } else if (action === "apply_learning") {
    const days = Number((req.body as { days?: number })?.days || 30) || 30;
    const scorecard = computeScorecard(days);
    const learning = await applyLearningFromScorecard(scorecard);
    const patched = patchStrategyParams({
      rsiBuyBelow:
        learning.suggestedRsiBuyBelow != null
          ? Number(learning.suggestedRsiBuyBelow)
          : undefined,
      takeProfitPct:
        learning.suggestedTakeProfitPct != null
          ? Number(learning.suggestedTakeProfitPct)
          : undefined,
      stopLossPct:
        learning.suggestedStopLossPct != null
          ? Number(learning.suggestedStopLossPct)
          : undefined,
      capitalPct:
        learning.suggestedCapitalPct != null
          ? Number(learning.suggestedCapitalPct)
          : undefined,
    });
    pushLog("info", `control apply_learning RSI=${patched.rsiBuyBelow} TP=${patched.takeProfitPct}%`);
    if (learning.blacklistCandidate) {
      addExcludedSymbol(String(learning.blacklistCandidate));
      pushLog("info", `apply_learning blacklist +${learning.blacklistCandidate}`);
    }
    return { ...getStatus(), learning, strategyParams: patched, blacklist: getExcludedSymbols() };
  } else {
    return reply.code(400).send({
      error:
        "action: start | stop | pause | sync_position | refresh_analysis | set_symbol | redeem_earn | consolidate_usdt | analyze_rotation | rotate_if_better | set_strategy_params | set_blacklist | set_blocked_hours | refresh_news | sync_trades | apply_learning",
    });
  }
  return getStatus();
});

app.post<{
  Body: {
    symbol?: string;
    side?: string;
    quantity?: string;
    quoteOrderQty?: string;
  };
}>("/order", async (req, reply) => {
  if (!controlAuthorized(req)) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  if (!hasCredentials()) {
    return reply.code(503).send({ error: "BINANCE credentials not configured" });
  }
  const symbol = req.body?.symbol || defaultSymbol;
  const side = (req.body?.side || "").toUpperCase();
  const quantity = req.body?.quantity;
  const quoteOrderQty = req.body?.quoteOrderQty;
  if (side !== "BUY" && side !== "SELL") {
    return reply.code(400).send({ error: "side: BUY | SELL" });
  }
  let order;
  if (side === "BUY" && quoteOrderQty && Number(quoteOrderQty) > 0) {
    pushLog("info", `manual BUY ${symbol} quote=${quoteOrderQty} USDT`);
    order = await createMarketBuyQuote(symbol, quoteOrderQty);
    const o = order as {
      executedQty?: string;
      cummulativeQuoteQty?: string;
    };
    const filledQty = Number(o.executedQty || 0);
    const fillPrice =
      filledQty > 0 && o.cummulativeQuoteQty
        ? Number(o.cummulativeQuoteQty) / filledQty
        : await fetchTickerPrice(symbol);
    if (filledQty > 0) openLong(fillPrice, filledQty);
  } else {
    if (!quantity || Number(quantity) <= 0) {
      return reply.code(400).send({ error: "quantity or quoteOrderQty required" });
    }
    pushLog("info", `manual order ${side} ${symbol} qty=${quantity}`);
    order = await createMarketOrder(symbol, side as "BUY" | "SELL", quantity);
    if (side === "SELL") {
      closePosition();
      if (consolidateEnabled()) {
        await consolidateToUsdt().catch(() => undefined);
      }
    }
    else {
      const fillPrice = await fetchTickerPrice(symbol);
      openLong(fillPrice, Number(quantity));
    }
  }
  return { ok: true, order };
});

async function main(): Promise<void> {
  setPositionPersistHook(persistPosition);
  initPositionFromStore(loadPersistedPosition());
  initDefaultBlacklist();
  initTradeLedger();
  pushLog("info", `boot port=${port} binance=${binanceBaseUrl()} creds=${hasCredentials()}`);
  if (hasCredentials() && process.env.AUBOT_SYNC_TRADES_ON_BOOT !== "false") {
    syncTradesFromBinance(
      Number(process.env.AUBOT_SYNC_TRADES_DAYS || "30") || 30,
    ).catch((e) => {
      pushLog(
        "warn",
        `sync trades boot: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }
  maybeAutoStart();
  await app.listen({ port, host });
  app.log.info(
    `AuBot trading listening on ${host}:${port} tick=${process.env.AUBOT_TICK_MS || 1000}ms`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
