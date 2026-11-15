type Level = "debug" | "info" | "warn" | "error";

const rank: Record<Level, number> = { debug: 10, error: 40, info: 20, warn: 30 };
let minimum: Level = "warn";

export function setLogLevel(level: Level): void {
  minimum = level;
}

export function log(level: Level, message: string, fields?: Record<string, unknown>): void {
  if (rank[level] < rank[minimum]) return;
  const line = JSON.stringify({ fields: fields ?? {}, level, message });
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
}
