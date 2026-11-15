import { existsSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EventEnvelope } from "../shared/envelope.js";
import { parseEnvelope } from "../shared/envelope.js";
import { log } from "../shared/logger.js";
import { isStateChanging } from "../shared/normalizer.js";
import { PERF } from "../shared/perf.js";
import { loadConfig, loadToken, type SenderConfig } from "./config.js";
import { SENDER_VERSION } from "./payload.js";
import {
  appendDeadLetter,
  appendEnvelope,
  claimSpoolFile,
  isToolPulse,
  listClaimFiles,
  listSpoolFiles,
  spoolStats,
} from "./spool.js";

export interface DaemonOptions {
  coalesceMs?: number;
  fetchFn?: typeof fetch;
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export interface FlushStats {
  batches: number;
  deadLettered: number;
  eventsSent: number;
  requests: number;
}

export function retryDelayMs(
  attempt: number,
  baseMs: number = PERF.retryBaseMs,
  maxMs: number = PERF.retryMaxMs,
): number {
  const jitterByte = globalThis.crypto.getRandomValues(new Uint8Array(1))[0] ?? 0;
  const jitter = Math.floor((jitterByte / 255) * PERF.retryJitterMs);
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1)) + jitter;
}

export function coalesceEnvelopes(events: EventEnvelope[]): EventEnvelope[] {
  const merged = new Map<string, EventEnvelope>();
  const output: EventEnvelope[] = [];
  for (const event of events) {
    if (!isToolPulse(event)) {
      output.push(event);
      continue;
    }
    const key = `${event.session_id}\0${event.agent_id ?? ""}\0${event.agent_type ?? ""}`;
    const prior = merged.get(key);
    if (!prior) {
      const copy = { ...event, pulse_count: event.pulse_count ?? 1 };
      merged.set(key, copy);
      output.push(copy);
      continue;
    }
    prior.pulse_count = (prior.pulse_count ?? 1) + (event.pulse_count ?? 1);
    prior.dropped_tool_events = (prior.dropped_tool_events ?? 0) + (event.dropped_tool_events ?? 0);
    prior.event_name = event.event_name;
    if (event.tool_name) prior.tool_name = event.tool_name;
    prior.occurred_at = event.occurred_at;
    prior.cli_version = event.cli_version;
  }
  return output;
}

export function chunkEvents(events: EventEnvelope[]): EventEnvelope[][] {
  const chunks: EventEnvelope[][] = [];
  let current: EventEnvelope[] = [];
  let bytes = 2;
  for (const event of events) {
    const size = Buffer.byteLength(JSON.stringify(event)) + 1;
    if (
      current.length > 0 &&
      (current.length >= PERF.daemonBatchMaxEvents || bytes + size > PERF.daemonBatchMaxBytes)
    ) {
      chunks.push(current);
      current = [];
      bytes = 2;
    }
    current.push(event);
    bytes += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function attemptsPath(config: SenderConfig): string {
  return join(config.home, "event-attempts.json");
}

function readAttempts(config: SenderConfig): Record<string, number> {
  const path = attemptsPath(config);
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    const result: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number") result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

function writeAttempts(config: SenderConfig, attempts: Record<string, number>): void {
  const entries = Object.entries(attempts).slice(-10_000);
  writeFileSync(attemptsPath(config), JSON.stringify(Object.fromEntries(entries)));
}

function recordSuccess(config: SenderConfig, count: number): void {
  writeFileSync(
    config.statePath,
    JSON.stringify({
      events_sent_total: count,
      last_successful_post_at: new Date().toISOString(),
      sender_version: SENDER_VERSION,
    }),
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class DaemonRunner {
  private readonly config: SenderConfig;
  private readonly fetchFn: typeof fetch;
  private readonly maxAttempts: number;
  private pending: EventEnvelope[] = [];
  private pendingSince = 0;
  private readonly activeClaims = new Set<string>();
  readonly stats: FlushStats = { batches: 0, deadLettered: 0, eventsSent: 0, requests: 0 };

  constructor(config: SenderConfig, options: DaemonOptions = {}) {
    this.config = config;
    this.fetchFn = options.fetchFn ?? fetch;
    this.maxAttempts = options.maxAttempts ?? PERF.retryMaxAttempts;
    this.retryBaseMs = options.retryBaseMs ?? PERF.retryBaseMs;
    this.retryMaxMs = options.retryMaxMs ?? PERF.retryMaxMs;
    this.coalesceMs = options.coalesceMs ?? PERF.toolCoalesceMs;
  }

  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly coalesceMs: number;

  private readClaim(path: string, events: EventEnvelope[]): void {
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    const poison: string[] = [];
    for (const line of lines) {
      try {
        events.push(parseEnvelope(JSON.parse(line)));
      } catch {
        poison.push(line);
      }
    }
    if (poison.length) {
      appendDeadLetter(this.config.home, poison, "invalid_spool_line");
      this.stats.deadLettered += poison.length;
    }
  }

  private collect(): EventEnvelope[] {
    const events: EventEnvelope[] = [];
    for (const recovered of listClaimFiles(this.config.spoolDir)) {
      if (this.activeClaims.has(recovered)) continue;
      try {
        this.activeClaims.add(recovered);
        this.readClaim(recovered, events);
      } catch (error) {
        log("warn", "spool claim recovery failed", { error: String(error) });
      }
    }
    for (const file of listSpoolFiles(this.config.spoolDir)) {
      try {
        const claimed = claimSpoolFile(file);
        this.activeClaims.add(claimed);
        this.readClaim(claimed, events);
      } catch (error) {
        log("warn", "spool claim failed", { error: String(error) });
      }
    }
    return events;
  }

  private resolveClaims(): void {
    if (this.pending.length) return;
    for (const path of this.activeClaims) {
      if (existsSync(path)) rmSync(path);
    }
    this.activeClaims.clear();
  }

  private async postBatch(events: EventEnvelope[]): Promise<boolean> {
    const token = loadToken(this.config);
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      this.stats.requests += 1;
      try {
        const response = await this.fetchFn(`${this.config.endpoint}/api/ingest`, {
          body: JSON.stringify({ events }),
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          method: "POST",
        });
        if (response.ok) {
          this.stats.batches += 1;
          this.stats.eventsSent += events.length;
          recordSuccess(this.config, this.stats.eventsSent);
          return true;
        }
        if (response.status < 500 && response.status !== 429) {
          appendDeadLetter(
            this.config.home,
            events.map((event) => JSON.stringify(event)),
            `ingest_http_${response.status}`,
          );
          this.stats.deadLettered += events.length;
          return false;
        }
      } catch (error) {
        log("warn", "ingest request failed", { attempt, error: String(error) });
      }
      if (attempt < this.maxAttempts) {
        await sleep(retryDelayMs(attempt, this.retryBaseMs, this.retryMaxMs));
      }
    }
    const attempts = readAttempts(this.config);
    const requeue: EventEnvelope[] = [];
    for (const event of events) {
      const count = (attempts[event.event_id] ?? 0) + 1;
      attempts[event.event_id] = count;
      if (count >= this.maxAttempts) {
        appendDeadLetter(this.config.home, [JSON.stringify(event)], "retry_exhausted");
        this.stats.deadLettered += 1;
        delete attempts[event.event_id];
      } else {
        requeue.push(event);
      }
    }
    writeAttempts(this.config, attempts);
    for (const event of requeue) appendEnvelope(this.config.spoolDir, event);
    return false;
  }

  private async send(events: EventEnvelope[]): Promise<void> {
    for (const chunk of chunkEvents(events)) {
      await this.postBatch(chunk);
    }
  }

  async collectAndMaybeFlush(now = Date.now()): Promise<void> {
    const incoming = this.collect();
    for (const event of incoming) {
      if (isToolPulse(event)) {
        if (!this.pending.length) this.pendingSince = now;
        this.pending.push(event);
        continue;
      }
      if (isStateChanging(event.event_name) || event.event_name === "SpoolDropped") {
        const merged = coalesceEnvelopes(this.pending);
        this.pending = [];
        await this.send([...merged, event]);
        continue;
      }
      await this.send([event]);
    }
    if (this.pending.length && now - this.pendingSince >= this.coalesceMs) {
      const merged = coalesceEnvelopes(this.pending);
      this.pending = [];
      await this.send(merged);
    }
    this.resolveClaims();
  }

  async flushAll(): Promise<FlushStats> {
    await this.collectAndMaybeFlush();
    if (this.pending.length) {
      const merged = coalesceEnvelopes(this.pending);
      this.pending = [];
      await this.send(merged);
    }
    this.resolveClaims();
    return this.stats;
  }

  async heartbeat(): Promise<boolean> {
    const token = loadToken(this.config);
    const depth = spoolStats(this.config.spoolDir).lines + this.pending.length;
    try {
      const response = await this.fetchFn(`${this.config.endpoint}/api/heartbeat`, {
        body: JSON.stringify({
          sender_version: SENDER_VERSION,
          spool_depth: depth,
        }),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        method: "POST",
      });
      return response.ok;
    } catch (error) {
      log("warn", "heartbeat failed", { error: String(error) });
      return false;
    }
  }
}

export async function flushOnce(
  config: SenderConfig,
  options: DaemonOptions = {},
): Promise<FlushStats> {
  const runner = new DaemonRunner(config, options);
  return runner.flushAll();
}

async function main(): Promise<void> {
  const config = loadConfig();
  const once = process.argv.includes("--once");
  const runner = new DaemonRunner(config, {
    maxAttempts: Math.min(
      10,
      Math.max(1, Number(process.env.AGENT_BOARD_RETRY_MAX_ATTEMPTS ?? PERF.retryMaxAttempts)),
    ),
    retryBaseMs: Math.max(10, Number(process.env.AGENT_BOARD_RETRY_BASE_MS ?? PERF.retryBaseMs)),
    retryMaxMs: Math.max(10, Number(process.env.AGENT_BOARD_RETRY_MAX_MS ?? PERF.retryMaxMs)),
  });
  if (once) {
    await runner.flushAll();
    await runner.heartbeat();
    return;
  }
  const pollMs: number = PERF.daemonPollMs;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runner.collectAndMaybeFlush();
    } finally {
      running = false;
    }
  };
  await tick();
  await runner.heartbeat();
  const watcher = existsSync(config.spoolDir) ? watch(config.spoolDir, () => void tick()) : null;
  const poll = setInterval(() => void tick(), pollMs);
  const heartbeat = setInterval(() => void runner.heartbeat(), PERF.heartbeatIntervalMs);
  const stop = () => {
    watcher?.close();
    clearInterval(poll);
    clearInterval(heartbeat);
    void runner.flushAll().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error) => {
    log("error", "daemon failed", { error: String(error) });
    process.exitCode = 1;
  });
}
