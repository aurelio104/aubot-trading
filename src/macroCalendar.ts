/** Ventanas macro conocidas (UTC). Env: AUBOT_MACRO_EVENTS=2026-06-01T18:00:FOMC,2026-06-12T12:30:CPI */
export interface MacroEvent {
  at: string;
  label: string;
  blockHoursBefore: number;
  blockHoursAfter: number;
}

export interface MacroWindow {
  active: boolean;
  event: MacroEvent | null;
  reason: string;
}

function parseEvents(): MacroEvent[] {
  const raw = process.env.AUBOT_MACRO_EVENTS || "";
  const out: MacroEvent[] = [];
  for (const part of raw.split(/[,;]/)) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}):(.+)$/);
    if (!m) continue;
    out.push({
      at: `${m[1]}:00.000Z`,
      label: m[2].trim(),
      blockHoursBefore: Number(process.env.AUBOT_MACRO_BLOCK_BEFORE_H || "2") || 2,
      blockHoursAfter: Number(process.env.AUBOT_MACRO_BLOCK_AFTER_H || "1") || 1,
    });
  }
  return out;
}

export function macroCalendarEnabled(): boolean {
  return process.env.AUBOT_MACRO_CALENDAR !== "false";
}

export function getActiveMacroWindow(now = Date.now()): MacroWindow {
  if (!macroCalendarEnabled()) {
    return { active: false, event: null, reason: "calendario macro off" };
  }
  for (const ev of parseEvents()) {
    const t = new Date(ev.at).getTime();
    if (!Number.isFinite(t)) continue;
    const start = t - ev.blockHoursBefore * 3600_000;
    const end = t + ev.blockHoursAfter * 3600_000;
    if (now >= start && now <= end) {
      return {
        active: true,
        event: ev,
        reason: `ventana macro ${ev.label} (${ev.at.slice(0, 16)} UTC)`,
      };
    }
  }
  return { active: false, event: null, reason: "sin evento macro programado" };
}
