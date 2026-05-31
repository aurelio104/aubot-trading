import fs from "node:fs";
import path from "node:path";
import type { Position } from "./position.js";

const STATE_DIR =
  process.env.AUBOT_STATE_DIR || process.env.AUBOT_STATE_PATH || "/tmp";
const STATE_FILE = path.join(STATE_DIR, "aubot-position.json");

export function positionPersistenceEnabled(): boolean {
  return process.env.AUBOT_PERSIST_POSITION !== "false";
}

export function loadPersistedPosition(): Position | null {
  if (!positionPersistenceEnabled()) return null;
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const d = JSON.parse(raw) as Position;
    if (d?.side === "LONG" && d.quantity > 0 && d.entryPrice > 0) return d;
  } catch {
    /* no file */
  }
  return null;
}

export function persistPosition(pos: Position | null): void {
  if (!positionPersistenceEnabled()) return;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    if (!pos) {
      try {
        fs.unlinkSync(STATE_FILE);
      } catch {
        /* ok */
      }
      return;
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(pos, null, 2));
  } catch {
    /* disk full / read-only */
  }
}
