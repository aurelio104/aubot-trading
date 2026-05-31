import fs from "node:fs";
import path from "node:path";

export interface JournalEntry {
  at: string;
  side: "BUY" | "SELL";
  symbol: string;
  price: number;
  quantity: number;
  reason: string;
  score?: number;
  rsi?: number;
  signal?: string;
  pnlUsdt?: number;
  pnlPct?: number;
}

const WS = process.env.AUBOT_JOURNAL_DIR || "/tmp";
const JOURNAL = path.join(WS, "aubot-decisiones.jsonl");
const AUDIT = path.join(WS, "aubot-orders-audit.jsonl");

export function journalEnabled(): boolean {
  return process.env.AUBOT_JOURNAL_ENABLED !== "false";
}

function append(file: string, row: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + "\n");
  } catch {
    /* read-only fs */
  }
}

export function logDecision(entry: JournalEntry): void {
  if (!journalEnabled()) return;
  append(JOURNAL, entry as unknown as Record<string, unknown>);
}

export function logOrderAudit(row: {
  at: string;
  symbol: string;
  side: string;
  qty: string;
  price?: number;
  clientOrderId?: string;
  reason: string;
}): void {
  if (!journalEnabled()) return;
  append(AUDIT, row);
}
