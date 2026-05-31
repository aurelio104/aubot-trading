import { pushLog } from "./log.js";
import { getActiveMacroWindow } from "./macroCalendar.js";

export type NewsImpact = "NONE" | "LOW" | "MED" | "HIGH";

export interface NewsHeadline {
  title: string;
  impact: NewsImpact;
  sentiment: number;
  symbols: string[];
  source: string;
}

export interface NewsSnapshot {
  at: string;
  enabled: boolean;
  fearGreed: number | null;
  fearGreedLabel: string;
  btcSentiment: number;
  maxImpact: NewsImpact;
  blockAllEntries: boolean;
  blockUntil: string | null;
  minScoreBoost: number;
  blockedSymbols: string[];
  macroWindow: boolean;
  gateReason: string;
  headlines: NewsHeadline[];
  summaryEs: string;
}

let cached: NewsSnapshot | null = null;
let cachedAt = 0;

const TTL_MS = Math.max(
  60_000,
  (Number(process.env.AUBOT_NEWS_TTL_SEC || "900") || 900) * 1000,
);

const RSS_FEEDS = (
  process.env.AUBOT_NEWS_RSS ||
  "https://www.coindesk.com/arc/outboundfeeds/rss/,https://cointelegraph.com/rss"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const NEG_HIGH =
  /\b(hack|hacked|exploit|exploited|breach|stolen|sec sue|indicted|delist|delisting|bankrupt|insolvent|withdrawals suspended|halt trading|emergency shutdown|rug pull|ponzi)\b/i;
const NEG_MED =
  /\b(bear market|crash|sell-off|selloff|crackdown|investigation|lawsuit|regulat|sanction|warning|ban crypto|outflow)\b/i;
const NEG_MACRO =
  /\b(fomc|federal reserve|interest rate decision|cpi report|consumer price index|nonfarm|jobs report|inflation data|powell)\b/i;

const SYMBOL_ALIASES: Record<string, string[]> = {
  BTC: ["bitcoin", "btc"],
  ETH: ["ethereum", "eth"],
  SOL: ["solana", "sol"],
  XRP: ["ripple", "xrp"],
  DOGE: ["dogecoin", "doge"],
  SHIB: ["shiba", "shib"],
  PEPE: ["pepe"],
  UNI: ["uniswap", "uni"],
  LINK: ["chainlink", "link"],
  ARB: ["arbitrum", "arb"],
  APT: ["aptos", "apt"],
  STX: ["stacks", "stx"],
};

export function newsContextEnabled(): boolean {
  return process.env.AUBOT_NEWS_CONTEXT !== "false";
}

function baseAsset(symbol: string): string {
  return symbol.toUpperCase().replace(/USDT$|BUSD$|USDC$/, "");
}

function extractSymbols(text: string): string[] {
  const lower = text.toLowerCase();
  const found = new Set<string>();
  for (const [sym, words] of Object.entries(SYMBOL_ALIASES)) {
    for (const w of words) {
      if (new RegExp(`\\b${w}\\b`, "i").test(lower)) found.add(sym);
    }
  }
  const m = text.match(/\b([A-Z]{2,10})USDT\b/g);
  if (m) for (const x of m) found.add(x.replace(/USDT$/, ""));
  return [...found];
}

function scoreHeadline(title: string): {
  impact: NewsImpact;
  sentiment: number;
  symbols: string[];
  macro: boolean;
} {
  const t = title.trim();
  let impact: NewsImpact = "NONE";
  let sentiment = 0;
  let macro = false;
  if (NEG_MACRO.test(t)) {
    impact = "HIGH";
    sentiment = -45;
    macro = true;
  } else if (NEG_HIGH.test(t)) {
    impact = "HIGH";
    sentiment = -70;
  } else if (NEG_MED.test(t)) {
    impact = "MED";
    sentiment = -35;
  } else if (/\b(approval|etf approved|partnership|record high|surge|rally)\b/i.test(t)) {
    impact = "LOW";
    sentiment = 15;
  }
  return { impact, sentiment, symbols: extractSymbols(t), macro };
}

async function fetchFearGreed(): Promise<{ value: number; label: string } | null> {
  try {
    const res = await fetch("https://api.alternative.me/fng/?limit=1", {
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      data?: { value?: string; value_classification?: string }[];
    };
    const row = j.data?.[0];
    if (!row?.value) return null;
    return {
      value: Number(row.value),
      label: row.value_classification || "Unknown",
    };
  } catch {
    return null;
  }
}

async function fetchRssTitles(url: string): Promise<string[]> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { "User-Agent": "AuBot-News/1.0" },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const titles: string[] = [];
    const re = /<title(?:[^>]*)>([\s\S]*?)<\/title>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      let t = m[1]
        .replace(/<!\[CDATA\[|\]\]>/g, "")
        .replace(/<[^>]+>/g, "")
        .trim();
      if (t && !/^coin(desk|telegraph)/i.test(t) && t.length > 12) {
        titles.push(t.slice(0, 240));
      }
    }
    return titles.slice(0, 12);
  } catch {
    return [];
  }
}

function fearGreedSentiment(fg: number | null): number {
  if (fg == null) return 0;
  if (fg <= 20) return -25;
  if (fg <= 35) return -12;
  if (fg >= 80) return 8;
  if (fg >= 65) return 4;
  return 0;
}

export async function refreshNewsContext(): Promise<NewsSnapshot> {
  const fg = await fetchFearGreed();
  const headlines: NewsHeadline[] = [];
  const sources = RSS_FEEDS.slice(0, 3);

  for (const feed of sources) {
    const host = feed.replace(/^https?:\/\//, "").split("/")[0] || "rss";
    for (const title of await fetchRssTitles(feed)) {
      const s = scoreHeadline(title);
      if (s.impact === "NONE" && s.sentiment === 0) continue;
      headlines.push({
        title,
        impact: s.impact,
        sentiment: s.sentiment,
        symbols: s.symbols,
        source: host,
      });
    }
  }

  headlines.sort((a, b) => {
    const rank = { HIGH: 3, MED: 2, LOW: 1, NONE: 0 };
    return rank[b.impact] - rank[a.impact] || a.sentiment - b.sentiment;
  });

  const top = headlines.slice(0, 8);
  let maxImpact: NewsImpact = "NONE";
  let btcSentiment = fearGreedSentiment(fg?.value ?? null);
  let macroWindow = false;
  const blockedSymbols = new Set<string>();
  let blockAll = false;
  let gateReason = "sin eventos críticos";

  for (const h of top) {
    if (h.impact === "HIGH") maxImpact = "HIGH";
    else if (h.impact === "MED" && maxImpact !== "HIGH") maxImpact = "MED";
    else if (h.impact === "LOW" && maxImpact === "NONE") maxImpact = "LOW";
    btcSentiment += h.sentiment * 0.15;
    if (NEG_MACRO.test(h.title)) macroWindow = true;
    if (h.impact === "HIGH" && h.sentiment <= -50) {
      blockAll = true;
      gateReason = `titular alto impacto: ${h.title.slice(0, 80)}`;
    }
    if (h.impact === "HIGH" && h.sentiment < 0) {
      for (const sym of h.symbols) blockedSymbols.add(`${sym}USDT`);
    }
  }

  btcSentiment = Math.max(-100, Math.min(100, Math.round(btcSentiment)));

  if (macroWindow && !blockAll) {
    blockAll = true;
    gateReason = "ventana macro (FOMC/CPI/tasas) — entradas pausadas";
  }
  const cal = getActiveMacroWindow();
  if (cal.active && !blockAll) {
    blockAll = true;
    macroWindow = true;
    gateReason = cal.reason;
  }
  if (fg != null && fg.value <= 15 && !blockAll) {
    gateReason = `Fear & Greed extremo (${fg.value}) — entradas más selectivas`;
  }

  let minScoreBoost = 0;
  if (btcSentiment <= -40) minScoreBoost = 15;
  else if (btcSentiment <= -25) minScoreBoost = 10;
  else if (btcSentiment <= -12) minScoreBoost = 5;
  else if (btcSentiment >= 20 && fg != null && fg.value >= 70) minScoreBoost = -3;

  const blockHours = Math.max(
    1,
    Number(process.env.AUBOT_NEWS_BLOCK_HOURS || "4") || 4,
  );
  const blockUntil = blockAll
    ? new Date(Date.now() + blockHours * 3600_000).toISOString()
    : null;

  const summaryParts: string[] = [];
  if (fg != null) summaryParts.push(`F&G ${fg.value} (${fg.label})`);
  summaryParts.push(`sentimiento BTC ${btcSentiment}`);
  if (maxImpact !== "NONE") summaryParts.push(`impacto max ${maxImpact}`);
  if (blockAll) summaryParts.push("gate: entradas bloqueadas");
  else if (minScoreBoost > 0) summaryParts.push(`umbral score +${minScoreBoost}`);

  const snap: NewsSnapshot = {
    at: new Date().toISOString(),
    enabled: true,
    fearGreed: fg?.value ?? null,
    fearGreedLabel: fg?.label ?? "—",
    btcSentiment,
    maxImpact,
    blockAllEntries: blockAll,
    blockUntil,
    minScoreBoost,
    blockedSymbols: [...blockedSymbols],
    macroWindow,
    gateReason,
    headlines: top,
    summaryEs: summaryParts.join(" · "),
  };

  cached = snap;
  cachedAt = Date.now();
  pushLog(
    "info",
    `newsContext F&G=${fg?.value ?? "?"} btcSent=${btcSentiment} impact=${maxImpact} block=${blockAll}`,
  );
  return snap;
}

export async function ensureNewsContext(): Promise<NewsSnapshot | null> {
  if (!newsContextEnabled()) return null;
  if (cached && Date.now() - cachedAt < TTL_MS) return cached;
  try {
    return await refreshNewsContext();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    pushLog("warn", `newsContext refresh failed: ${msg}`);
    return cached;
  }
}

export function getCachedNews(): NewsSnapshot | null {
  return cached;
}

export function newsMinScoreBoost(news?: NewsSnapshot | null): number {
  if (!newsContextEnabled()) return 0;
  const n = news ?? cached;
  return n?.minScoreBoost ?? 0;
}

export function newsBlocksEntry(
  symbol: string,
  news?: NewsSnapshot | null,
): boolean {
  if (!newsContextEnabled()) return false;
  const n = news ?? cached;
  if (!n) return false;
  if (n.blockAllEntries) return true;
  const base = baseAsset(symbol);
  for (const blocked of n.blockedSymbols) {
    if (baseAsset(blocked) === base) return true;
  }
  return false;
}

export function newsGateReason(
  symbol: string,
  news?: NewsSnapshot | null,
): string {
  const n = news ?? cached;
  if (!n) return "";
  if (n.blockAllEntries) return n.gateReason;
  const base = baseAsset(symbol);
  for (const blocked of n.blockedSymbols) {
    if (baseAsset(blocked) === base) {
      return `par ${symbol} bloqueado por titular negativo reciente`;
    }
  }
  return "";
}
