/**
 * WR por par — actualización automática desde historial live (+ merge demo).
 */
import fs from "node:fs";
import path from "node:path";
import { pushLog } from "./log.js";
import { computeScorecard, type Scorecard } from "./tradeLedger.js";
import { reloadPairWr } from "./pairBacktestGate.js";

export interface PairWrRow {
  symbol: string;
  winRatePct: number;
  trades: number;
  pnlUsdt?: number;
  source?: string;
}

function wrFilePath(): string {
  return (
    process.env.AUBOT_PAIR_WR_JSON ||
    path.join(process.env.AUBOT_JOURNAL_DIR || "/data/journal", "aubot-pair-wr.json")
  );
}

function minTradesForWr(): number {
  return Math.max(1, Number(process.env.AUBOT_PAIR_WR_MIN_TRADES || "2") || 2);
}

function loadExisting(): Map<string, PairWrRow> {
  const map = new Map<string, PairWrRow>();
  const fp = wrFilePath();
  try {
    if (!fs.existsSync(fp)) return map;
    const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as {
      pairs?: PairWrRow[];
      results?: PairWrRow[];
    };
    for (const r of raw.pairs || raw.results || []) {
      if (r.symbol) map.set(r.symbol.toUpperCase(), r);
    }
  } catch {
    /* ignore */
  }
  return map;
}

function rowsFromScorecard(sc: Scorecard): PairWrRow[] {
  const rows: PairWrRow[] = [];
  for (const [symbol, v] of Object.entries(sc.bySymbol)) {
    if (v.n < minTradesForWr()) continue;
    rows.push({
      symbol: symbol.toUpperCase(),
      winRatePct: Number(((v.wins / v.n) * 100).toFixed(1)),
      trades: v.n,
      pnlUsdt: v.pnl,
      source: "live",
    });
  }
  return rows;
}

export function updatePairWrFromScorecard(
  sc?: Scorecard,
  days = 30,
): { path: string; pairs: PairWrRow[]; added: number } {
  const scorecard = sc ?? computeScorecard(days);
  const live = rowsFromScorecard(scorecard);
  const merged = loadExisting();

  for (const row of live) {
    merged.set(row.symbol, row);
  }

  const pairs = [...merged.values()].sort((a, b) => b.winRatePct - a.winRatePct);
  const fp = wrFilePath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(
    fp,
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        source: "live+merge",
        days,
        pairs,
      },
      null,
      2,
    ) + "\n",
  );
  reloadPairWr();
  pushLog("info", `pairWrStore: ${pairs.length} pares → ${fp}`);
  return { path: fp, pairs, added: live.length };
}

let lastNightlyDate = "";

export function pairWrNightlyEnabled(): boolean {
  return process.env.AUBOT_PAIR_WR_NIGHTLY !== "false";
}

export function maybeRunNightlyPairWrUpdate(): void {
  if (!pairWrNightlyEnabled()) return;
  const tz = process.env.AUBOT_ADMIN_TZ || process.env.AUBOT_TZ || "UTC";
  const hour = Math.max(
    0,
    Math.min(23, Number(process.env.AUBOT_PAIR_WR_UPDATE_HOUR || "3") || 3),
  );
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
  } catch {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      hour: "numeric",
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dayKey = `${get("year")}-${get("month")}-${get("day")}`;
  const h = Number(get("hour"));
  if (h !== hour || lastNightlyDate === dayKey) return;
  lastNightlyDate = dayKey;
  updatePairWrFromScorecard(undefined, 30);
  pushLog("info", `pairWr nightly update (${tz} ${hour}:00)`);
}
