import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { EventEnvelope } from "../src/shared/envelope.js";
import type { SenderConfig } from "../src/sender/config.js";
import { DaemonRunner, coalesceEnvelopes } from "../src/sender/daemon.js";
import { appendEnvelope, spoolStats } from "../src/sender/spool.js";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "agent-board-test-"));
}

function config(home: string, endpoint: string): SenderConfig {
  writeFileSync(join(home, "token"), "test-token");
  return {
    configPath: join(home, "config.json"),
    endpoint,
    home,
    machineId: "machine-a",
    spoolDir: join(home, "spool"),
    statePath: join(home, "state.json"),
    tokenPath: join(home, "token"),
  };
}

function envelope(id: string, name: string, session = "session-1"): EventEnvelope {
  return {
    cli: "claude-code",
    cli_version: "test",
    event_id: id,
    event_name: name,
    occurred_at: "2026-01-01T00:00:00.000Z",
    sender_version: "test",
    session_id: session,
    tool_name: "Bash",
    v: 1,
  };
}

async function serve(
  handler: (body: unknown) => number,
): Promise<{ bodies: unknown[]; url: string; close: () => Promise<void> }> {
  const bodies: unknown[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      bodies.push(body);
      response.statusCode = handler(body);
      response.setHeader("content-type", "application/json");
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server has no port");
  return {
    bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    url: `http://127.0.0.1:${address.port}`,
  };
}

test("coalescing keeps the latest tool and sums pulses", () => {
  const merged = coalesceEnvelopes([
    envelope("p1", "PreToolUse"),
    { ...envelope("p2", "PostToolUse"), tool_name: "Read" },
    envelope("s1", "Stop"),
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0]?.pulse_count, 2);
  assert.equal(merged[0]?.tool_name, "Read");
  assert.equal(merged[1]?.event_name, "Stop");
});

test("daemon sends 200 rapid pulses as one request and one event", async () => {
  const home = tempHome();
  const server = await serve(() => 200);
  try {
    const cfg = config(home, server.url);
    for (let i = 0; i < 200; i += 1)
      appendEnvelope(cfg.spoolDir, envelope(`pulse-${i}`, "PreToolUse"));
    const runner = new DaemonRunner(cfg, { coalesceMs: 0, retryBaseMs: 1 });
    const stats = await runner.flushAll();
    assert.equal(stats.requests, 1);
    assert.equal(server.bodies.length, 1);
    const body = server.bodies[0] as { events: EventEnvelope[] };
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0]?.pulse_count, 200);
  } finally {
    await server.close();
  }
});

test("daemon retries, requeues after a failed run, then succeeds without loss", async () => {
  const home = tempHome();
  let status = 500;
  const server = await serve(() => status);
  try {
    const cfg = config(home, server.url);
    appendEnvelope(cfg.spoolDir, envelope("state-1", "SessionStart"));
    const first = new DaemonRunner(cfg, { maxAttempts: 2, retryBaseMs: 1, retryMaxMs: 2 });
    await first.flushAll();
    assert.equal(spoolStats(cfg.spoolDir).lines, 1);
    status = 200;
    const second = new DaemonRunner(cfg, { maxAttempts: 2, retryBaseMs: 1, retryMaxMs: 2 });
    const stats = await second.flushAll();
    assert.equal(stats.eventsSent, 1);
    assert.equal(spoolStats(cfg.spoolDir).lines, 0);
  } finally {
    await server.close();
  }
});

test("poison spool lines are dead lettered while valid lines send", async () => {
  const home = tempHome();
  const server = await serve(() => 200);
  try {
    const cfg = config(home, server.url);
    appendEnvelope(cfg.spoolDir, envelope("valid-1", "SessionStart"));
    const files = spoolStats(cfg.spoolDir);
    assert.equal(files.files, 1);
    const path = join(cfg.spoolDir, readdirSync(cfg.spoolDir)[0] as string);
    writeFileSync(path, `${readFileSync(path, "utf8")}{not json}\n`);
    const runner = new DaemonRunner(cfg, { retryBaseMs: 1 });
    const stats = await runner.flushAll();
    assert.equal(stats.eventsSent, 1);
    assert.equal(stats.deadLettered, 1);
    assert.equal(existsSync(join(home, "dead-letter.jsonl")), true);
  } finally {
    await server.close();
  }
});

test("spool caps hold and a drop marker is recorded", () => {
  const home = tempHome();
  const spoolDir = join(home, "spool");
  const caps = { maxBytes: 5000, maxFileBytes: 2000, maxFiles: 4 };
  let dropped = 0;
  for (let i = 0; i < 100; i += 1) {
    const outcome = appendEnvelope(
      spoolDir,
      envelope(`cap-${i}`, "PreToolUse", `session-${i % 3}`),
      caps,
    );
    dropped += outcome.droppedToolEvents;
  }
  const stats = spoolStats(spoolDir);
  assert.ok(stats.bytes <= caps.maxBytes + 2000, `spool bytes ${stats.bytes}`);
  assert.ok(stats.files <= caps.maxFiles + 1, `spool files ${stats.files}`);
  assert.ok(dropped > 0 || stats.lines < 100);
  const text = readdirSync(spoolDir)
    .map((name) => readFileSync(join(spoolDir, name), "utf8"))
    .join("\n");
  assert.ok(text.includes("SpoolDropped") || dropped > 0);
});
