import { PERF } from "./perf.js";

export const TITLE_LIMIT = 120;
export const PROMPT_LIMIT = 500;
export const MESSAGE_LIMIT = 500;
export const MAX_INGEST_BYTES = PERF.ingestMaxBytes;
export const MAX_INGEST_EVENTS = PERF.ingestMaxEvents;
export const EVENT_WINDOW_PER_SESSION = PERF.eventsPerSessionCap;

export function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return value.slice(0, limit);
}
