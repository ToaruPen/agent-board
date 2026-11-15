import assert from "node:assert/strict";
import test from "node:test";
import {
  EVENT_WINDOW_PER_SESSION,
  MAX_INGEST_BYTES,
  MAX_INGEST_EVENTS,
} from "../src/shared/limits.js";
import { setLogLevel } from "../src/shared/logger.js";
import { PERF } from "../src/shared/perf.js";
import { SENDER_PERF } from "../src/sender/config.js";
import { detectCli } from "../src/sender/payload.js";
import { DEFAULT_SPOOL_CAPS, spoolPath } from "../src/sender/spool.js";
import { sha256Hex, timingSafeEqual } from "../src/worker/auth.js";
import { WORKER_PERF } from "../src/worker/store.js";

test("sender and worker mirror the same performance caps", () => {
  assert.deepEqual(SENDER_PERF, PERF);
  assert.deepEqual(WORKER_PERF, PERF);
});

test("public helpers stay wired to the shared caps", async () => {
  assert.equal(MAX_INGEST_EVENTS, PERF.ingestMaxEvents);
  assert.equal(EVENT_WINDOW_PER_SESSION, PERF.eventsPerSessionCap);
  assert.equal(DEFAULT_SPOOL_CAPS.maxBytes, PERF.spoolMaxBytes);
  assert.ok(spoolPath("/tmp/spool", "session-1").endsWith(".jsonl"));
  assert.equal(detectCli({ "thread-id": "thread-1" }), "codex");
  setLogLevel("warn");
  const hash = await sha256Hex("token");
  assert.equal(hash.length, 64);
  assert.equal(timingSafeEqual(hash, hash), true);
  assert.equal(timingSafeEqual(hash, "0".repeat(64)), false);
});

test("performance caps are bounded and ordered", () => {
  assert.ok(PERF.daemonBatchMaxEvents <= PERF.ingestMaxEvents);
  assert.ok(PERF.daemonBatchMaxBytes < PERF.ingestMaxBytes);
  assert.ok(PERF.heartbeatIntervalMs >= 30_000);
  assert.ok(PERF.daemonPollMs >= 1_000);
  assert.ok(PERF.retryMaxAttempts <= 10);
  assert.ok(PERF.eventsPerSessionCap <= 200);
  assert.ok(PERF.mcpMaxLimit <= PERF.readMaxLimit);
  assert.ok(PERF.recentEventsMaxLimit <= 200);
});

test("dialogue caps are bounded", () => {
  assert.ok(PERF.dialogueExecTimeoutMs <= 900_000);
  assert.equal(PERF.dialogueExpiryMs, 86_400_000);
  assert.ok(PERF.dialogueMessageMaxChars <= 10_000);
  assert.ok(PERF.dialogueThreadCap <= 1_000);
  assert.ok(PERF.dialogueResultMaxBytes <= MAX_INGEST_BYTES);
});
