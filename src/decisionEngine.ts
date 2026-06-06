import { getConfig } from "./config.js";
import { getFreeUsdt } from "./capital.js";
import { hasOpenPosition, getPosition } from "./position.js";
import {
  getLastAnalysis,
  runMarketAnalysis,
} from "./marketAnalysis.js";
import {
  effectiveEnterMinScore,
  isBlockedHourUtc,
  isCircuitOpen,
  circuitOpenReason,
  stagnantMinScore,
  preserveModeActive,
} from "./runtimeConfig.js";
import { getCachedRegime, detectMarketRegime, marketRegimeEnabled, longRegimeAllowed, longRegimeGateEnabled } from "./marketRegime.js";
import {
  ensureNewsContext,
  getCachedNews,
  newsBlocksEntry,
  newsGateReason,
  newsMinScoreBoost,
} from "./newsContext.js";
import { getActiveMacroWindow } from "./macroCalendar.js";
import { checkMtfAlignment } from "./multiTimeframe.js";
import { checkEntryConfirmation } from "./entryConfirmation.js";
import {
  firstWinMinScoreBoost,
  firstWinRequireStrongBuy,
} from "./firstWinMode.js";
import {
  minNetEdgeUsdt,
  minNetEdgeUsdtForQuote,
  netProjectedProfitUsdt,
  roundTripFeePct,
} from "./capitalRules.js";
import {
  meetsMinRiskReward,
  preEntryLossStreakBlocked,
  tpCoversFeesAndEdge,
  minRiskRewardRatio,
  maxRiskPctPerTrade,
} from "./smartCapital.js";
import {
  buildFeeFirstPlan,
  applyFeeFirstPlan,
  enrichOpportunityWithFeePlan,
  feeFirstAutoEnabled,
} from "./feeFirstPlan.js";
import {
  evaluatePsychologyGuard,
} from "./psychologyGuard.js";
import { buildEntryChecklist, type EntryChecklistResult } from "./entryChecklist.js";
import {
  isHighConfidenceSetup,
  setHighConfidenceEligible,
  maxTradesAllowedToday,
} from "./tradeConfidence.js";
import {
  maxDailyLossUsdt,
  maxWeeklyLossUsdt,
  maxRiskUsdt,
  extremeFearMinScore,
  fgBlockBelow,
  rsiEntryMin,
  rsiEntryMax,
} from "./capitalPolicy.js";
import { canOpenNewTrade, getDayStats, getRiskBlockReason, isRiskBlocked, canOpenNewTradeAsync } from "./risk.js";
import { getTradingSymbol } from "./tradingSymbol.js";
import {
  buildBtcMarketContext,
  unifiedEntryBlocked,
  type BtcMarketSnapshot,
} from "./btcMarketContext.js";
import { buildAdaptiveCandidatePlan } from "./adaptiveCandidates.js";

export interface DecisionSnapshot {
  at: string;
  action: "HOLD_POSITION" | "WAIT" | "ENTER_CANDIDATE" | "BLOCKED";
  symbol: string;
  price: number;
  freeUsdt: number;
  reasons: string[];
  gates: Record<string, boolean | string | number>;
  technical: Record<string, unknown> | null;
  regime: Record<string, unknown> | null;
  news: Record<string, unknown> | null;
  macro: Record<string, unknown> | null;
  psychology?: Record<string, unknown> | null;
  checklist?: EntryChecklistResult | null;
  btcContext?: BtcMarketSnapshot | null;
  candidatePlan?: import("./adaptiveCandidates.js").AdaptiveCandidatePlan | null;
  summaryEs: string;
}

export async function evaluateDecision(): Promise<DecisionSnapshot> {
  const c = getConfig();
  const free = await getFreeUsdt();
  const reasons: string[] = [];
  const gates: Record<string, boolean | string | number> = {};
  const btcContext = await buildBtcMarketContext(free);
  const candidatePlan = buildAdaptiveCandidatePlan(free);
  gates.btcUnifiedGates = true;
  gates.capitalTier = candidatePlan.tier;
  gates.tradablePairs = candidatePlan.expandedCount;
  gates.btcTradable = candidatePlan.btcTradable;
  gates.btcAffordable = btcContext.affordable;
  gates.btcChange4hPct = btcContext.change4hPct;
  gates.btcChange24hPct = btcContext.change24hPct;
  if (unifiedEntryBlocked(btcContext)) {
    reasons.push(`contexto BTC unificado: ${btcContext.gateReason}`);
  }
  if (!btcContext.affordable) {
    reasons.push(
      "BTC no asequible con capital actual — mismos gates aplican al mejor alt",
    );
  }

  if (hasOpenPosition()) {
    const pos = getPosition()!;
    const sym = getTradingSymbol();
    const psychHold = evaluatePsychologyGuard(free);
    return {
      at: new Date().toISOString(),
      action: "HOLD_POSITION",
      symbol: sym,
      price: pos.entryPrice,
      freeUsdt: free,
      reasons: ["posición LONG abierta — gestionar TP/SL/trailing"],
      gates: { hasPosition: true, btcUnifiedGates: true },
      technical: null,
      regime: marketRegimeEnabled() ? (getCachedRegime() as unknown as Record<string, unknown>) : null,
      news: getCachedNews() as unknown as Record<string, unknown> | null,
      psychology: psychHold as unknown as Record<string, unknown>,
      macro: null,
      btcContext,
      candidatePlan,
      summaryEs: `Mantener posición ${sym} qty=${pos.quantity} · ${btcContext.summaryEs}`,
    };
  }

  const macro = getActiveMacroWindow();
  gates.macroActive = macro.active;
  if (macro.active) {
    reasons.push(macro.reason);
  }

  gates.circuitOpen = isCircuitOpen();
  if (isCircuitOpen()) reasons.push(circuitOpenReason());

  gates.riskBlocked = isRiskBlocked();
  if (isRiskBlocked()) reasons.push(getRiskBlockReason() || "risk blocked");

  gates.blockedHour = isBlockedHourUtc();
  if (isBlockedHourUtc()) reasons.push("hora UTC bloqueada (aprendizaje)");

  gates.canOpen = await canOpenNewTradeAsync();
  if (!gates.canOpen) reasons.push(getRiskBlockReason() || "canOpenNewTrade=false");

  const lossGate = preEntryLossStreakBlocked();
  gates.lossStreak = lossGate.streak;
  if (lossGate.blocked) reasons.push(lossGate.reason);

  const psych = evaluatePsychologyGuard(free);
  gates.maxDailyLossUsdt = maxDailyLossUsdt(free);
  gates.maxWeeklyLossUsdt = maxWeeklyLossUsdt(free);
  gates.maxRiskUsdt = maxRiskUsdt(free);
  gates.psychologyGuard = psych.enabled;
  gates.psychologySeverity = psych.severity;
  if (psych.enabled && psych.reasons.length) {
    reasons.push(...psych.reasons.slice(0, 1));
  }

  const news = await ensureNewsContext();
  gates.newsBlock = news?.blockAllEntries ?? false;
  gates.newsScoreBoost = newsMinScoreBoost(news);
  if (news?.blockAllEntries) reasons.push(news.gateReason || "noticias bloquean entradas");
  if ((news?.minScoreBoost ?? 0) > 0) {
    reasons.push(`noticias +${news?.minScoreBoost} umbral score`);
  }

  let regime = marketRegimeEnabled() ? getCachedRegime() : null;
  const analysis = getLastAnalysis() ?? (await runMarketAnalysis(free));
  if (marketRegimeEnabled() && !regime) {
    regime = await detectMarketRegime(analysis);
  }
  const blockBearEntry = process.env.AUBOT_BLOCK_ENTRY_BEAR !== "false";
  const regimeGateOn = longRegimeGateEnabled() && blockBearEntry;
  gates.regimeGateEnabled = regimeGateOn;
  gates.longRegimeAllowed = longRegimeAllowed(regime?.regime);
  gates.bearRegime = regime?.regime === "BEAR";
  if (regimeGateOn && !longRegimeAllowed(regime?.regime)) {
    const label = regime?.regime ?? "desconocido";
    reasons.push(
      `régimen ${label} — LONG solo en BULL/NEUTRAL (BTC ${typeof regime?.btcChange4hPct === "number" ? regime.btcChange4hPct.toFixed(2) : "?"}%)`,
    );
  }
  const extremeFear = (news?.fearGreed ?? 100) <= fgBlockBelow();
  gates.extremeFear = extremeFear;
  if (extremeFear) {
    reasons.push(`F&G ${news?.fearGreed} ≤ ${fgBlockBelow()} — LONG bloqueado`);
  }

  const minScore =
    Math.max(
      effectiveEnterMinScore(),
      regime?.minEnterScore ?? effectiveEnterMinScore(),
      preserveModeActive(free) ? 70 : 0,
      extremeFear ? extremeFearMinScore() : 0,
    ) +
    Math.max(0, newsMinScoreBoost(news)) +
    firstWinMinScoreBoost();

  gates.minScoreRequired = minScore;

  let best = analysis.best;
  const stagnant = stagnantMinScore();
  gates.stagnantThreshold = stagnant;

  let action: DecisionSnapshot["action"] = "WAIT";
  let technical: Record<string, unknown> | null = null;
  let checklist: EntryChecklistResult | null = null;

  if (!best?.affordable) {
    reasons.push("sin par asequible");
    action = "BLOCKED";
  } else {
    const mtf = await checkMtfAlignment(best.symbol);
    gates.mtfAligned = mtf.aligned;
    gates.mtfPenalty = mtf.penalty;
    if (!mtf.aligned) reasons.push(mtf.reason);

    const entryConf = await checkEntryConfirmation(best.symbol);
    gates.entryConfirmed = entryConf.confirmed;
    gates.entryRsi = entryConf.rsi;
    if (!entryConf.confirmed) reasons.push(`sin confirmación: ${entryConf.reason}`);

    if (feeFirstAutoEnabled()) {
      const plan = buildFeeFirstPlan(free, best);
      gates.feeFirstAuto = true;
      gates.feeFirstViable = plan.viable;
      gates.roundTripFeeUsdt = plan.roundTripFeeUsdt;
      gates.netProfitAtTpUsdt = plan.netProfitAtTpUsdt;
      gates.minNetRequiredUsdt = plan.minNetRequiredUsdt;
      gates.feeFirstTpPct = plan.tpPct;
      gates.feeFirstSlPct = plan.slPct;
      if (!plan.viable) {
        reasons.push(`fee-first: ${plan.reason}`);
      } else {
        best = enrichOpportunityWithFeePlan(best, applyFeeFirstPlan(plan));
      }
    }

    const effectiveMin = minScore + (mtf.aligned ? mtf.penalty : 0);
    gates.effectiveMinScore = effectiveMin;

    const strong = analysis.candidates.filter(
      (x) =>
        x.affordable &&
        x.buyScore >= stagnant &&
        (x.signal === "buy" || x.signal === "strong_buy"),
    );
    if (strong.length === 0) {
      reasons.push(`mercado estancado — ningún par score≥${stagnant} buy/strong_buy`);
    }

    const netEdge = netProjectedProfitUsdt(
      best.projectedProfitUsdt,
      best.quoteUsdt,
    );
    gates.netEdgeUsdt = netEdge;
    const minEdge = minNetEdgeUsdtForQuote(best.quoteUsdt || 0);
    gates.minNetEdge = minEdge;
    if (netEdge < minEdge) {
      reasons.push(
        `edge neto ${netEdge.toFixed(3)} < ${minEdge.toFixed(3)} USDT (fees ida+vuelta ~${((best.quoteUsdt || 0) * roundTripFeePct()) / 100} USDT)`,
      );
    }
    if (firstWinRequireStrongBuy() && best.signal !== "strong_buy") {
      reasons.push("modo primera ganancia: solo strong_buy hasta 1er cierre positivo");
    }

    const minRsiEntry = rsiEntryMin();
    const maxRsiEntry = rsiEntryMax();
    gates.maxRsiEntry = maxRsiEntry;
    gates.minRsiEntry = minRsiEntry;
    if (best.rsi > maxRsiEntry) {
      reasons.push(
        `RSI ${best.rsi.toFixed(1)} > ${maxRsiEntry} (sobrecompra — no entrar)`,
      );
    }
    if (best.rsi < minRsiEntry) {
      reasons.push(
        `RSI ${best.rsi.toFixed(1)} < ${minRsiEntry} (cuchillo — esperar rebote)`,
      );
    }

    const requiresStrong =
      extremeFear ||
      regime?.regime === "BEAR" ||
      (regime?.regime === "NEUTRAL" &&
        typeof regime.btcChange4hPct === "number" &&
        regime.btcChange4hPct < 0 &&
        (news?.btcSentiment ?? 0) < -15);
    gates.requiresStrongBuy = requiresStrong;
    if (requiresStrong && best.signal !== "strong_buy") {
      reasons.push("régimen bajista/miedo — solo strong_buy");
    }

    const tpUse = best.adaptiveTakeProfitPct ?? analysis.takeProfitPct;
    const slUse = best.adaptiveStopLossPct ?? analysis.stopLossPct;
    gates.tpPct = tpUse;
    gates.slPct = slUse;
    gates.rrRatio = slUse > 0 ? Number((tpUse / slUse).toFixed(2)) : 0;
    if (!meetsMinRiskReward(tpUse, slUse)) {
      reasons.push(
        `R:R ${gates.rrRatio} < mínimo ${minRiskRewardRatio()} (TP ${tpUse}% / SL ${slUse}%)`,
      );
    }
    if (!tpCoversFeesAndEdge(tpUse, best.quoteUsdt || 0)) {
      reasons.push(
        `TP ${tpUse}% no cubre fees×2 sobre ~${(best.quoteUsdt || 0).toFixed(2)} USDT`,
      );
    }

    const maxRisk = maxRiskPctPerTrade();
    const riskAtStake = ((best.quoteUsdt || 0) * slUse) / 100;
    const maxRiskUsdt = free * (maxRisk / 100);
    gates.maxRiskPct = maxRisk;
    gates.riskAtStakeUsdt = Number(riskAtStake.toFixed(4));
    gates.maxRiskUsdt = Number(maxRiskUsdt.toFixed(4));
    if (riskAtStake > maxRiskUsdt * 1.08) {
      reasons.push(
        `riesgo SL ~${riskAtStake.toFixed(2)} USDT > ${maxRiskUsdt.toFixed(2)} (${maxRisk}% capital)`,
      );
    }

    technical = {
      symbol: best.symbol,
      buyScore: best.buyScore,
      rawBuyScore: best.rawBuyScore ?? best.buyScore,
      macroPenalty: best.macroPenalty ?? 0,
      signal: best.signal,
      rsi: best.rsi,
      volumeOk: best.volumeOk ?? false,
      volumeRatio: best.volumeRatio ?? 0,
      projectedProfitUsdt: best.projectedProfitUsdt,
      netEdgeUsdt: netEdge,
      tpPct: tpUse,
      slPct: slUse,
      rrRatio: gates.rrRatio,
      mtf: mtf,
      entryConfirmation: entryConf,
    };

    checklist = buildEntryChecklist({
      freeUsdt: free,
      regime,
      news,
      best,
      entryConf,
      mtf,
      tpPct: tpUse,
      slPct: slUse,
      netEdgeUsdt: netEdge,
      lossStreakBlocked: lossGate.blocked,
      psychologyCritical: false,
      canOpen: Boolean(gates.canOpen),
      newsScoreBoost: newsMinScoreBoost(news),
    });
    gates.checklistPassed = checklist.passed;
    gates.checklistTotal = checklist.total;
    gates.checklistAllPassed = checklist.allPassed;
    technical.checklist = checklist;

    const highConf = isHighConfidenceSetup({
      checklistAllPassed: checklist.allPassed,
      signal: best.signal,
      regime: regime?.regime ?? null,
      fearGreed: news?.fearGreed ?? null,
      buyScore: best.buyScore,
      netEdgeUsdt: netEdge,
      minNetEdgeUsdt: minEdge,
    });
    setHighConfidenceEligible(highConf && checklist.allPassed);
    const dayTradePolicy = maxTradesAllowedToday(free);
    gates.tradesDayMode = dayTradePolicy.mode;
    gates.tradesDayMax = dayTradePolicy.max;
    gates.tradesDayPolicy = dayTradePolicy.reason;
    gates.highConfidenceSetup = highConf;
    if (highConf) {
      reasons.push("setup alta confianza — puede superar límite 1 trade/día");
    }

    const scoreOk = best.buyScore >= effectiveMin;
    const signalOk = best.signal === "buy" || best.signal === "strong_buy";

    if (unifiedEntryBlocked(btcContext)) {
      action = "BLOCKED";
    } else if (newsBlocksEntry(best.symbol, news)) {
      reasons.push(newsGateReason(best.symbol, news) || "par bloqueado por noticias");
      action = "BLOCKED";
    } else if (extremeFear) {
      action = "BLOCKED";
    } else if (regimeGateOn && !longRegimeAllowed(regime?.regime)) {
      action = "WAIT";
    } else if (
      macro.active ||
      isCircuitOpen() ||
      isRiskBlocked() ||
      !gates.canOpen ||
      lossGate.blocked ||
      isBlockedHourUtc() ||
      strong.length === 0 ||
      !scoreOk ||
      !signalOk ||
      (firstWinRequireStrongBuy() && best.signal !== "strong_buy") ||
      (feeFirstAutoEnabled() && gates.feeFirstViable === false) ||
      !checklist.allPassed
    ) {
      if (!checklist.allPassed) {
        reasons.push(checklist.summaryEs);
      }
      action = reasons.some((r) => /bloque|macro|circuit|risk|noticias bloquean|F&G|PAUSA/i.test(r))
        ? "BLOCKED"
        : "WAIT";
    } else {
      action = "ENTER_CANDIDATE";
      reasons.push(
        `✓ checklist ${checklist.passed}/${checklist.total} — ${best.symbol} score=${best.buyScore} net~${netEdge.toFixed(3)} USDT`,
      );
    }
  }

  const summary =
    action === "ENTER_CANDIDATE"
      ? `Operaría ${best?.symbol} si autoTrade confirma`
      : action === "BLOCKED"
        ? `Bloqueado: ${reasons[0] || "gates"}`
        : `Esperar: ${reasons.slice(0, 2).join("; ") || "sin señal fuerte"}`;

  return {
    at: new Date().toISOString(),
    action,
    symbol: best?.symbol ?? getTradingSymbol(),
    price: best?.price ?? 0,
    freeUsdt: free,
    reasons,
    gates,
    technical,
    regime: regime as unknown as Record<string, unknown> | null,
    news: news as unknown as Record<string, unknown> | null,
    psychology: psych as unknown as Record<string, unknown>,
    checklist,
    macro: { active: macro.active, reason: macro.reason, event: macro.event },
    btcContext,
    candidatePlan,
    summaryEs: summary,
  };
}
