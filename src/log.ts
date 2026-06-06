export interface LogEntry {
  at: string;
  level: "info" | "warn" | "error";
  msg: string;
}

const MAX = 300;
const entries: LogEntry[] = [];

export function pushLog(level: LogEntry["level"], msg: string): void {
  entries.push({ at: new Date().toISOString(), level, msg });
  if (entries.length > MAX) entries.shift();
}

export function getLogs(limit = 50): LogEntry[] {
  const n = Math.min(Math.max(1, limit), MAX);
  return entries.slice(-n);
}
