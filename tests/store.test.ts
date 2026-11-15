import assert from "node:assert/strict";
import test from "node:test";
import type { EventEnvelope } from "../src/shared/envelope.js";
import { BoardService, MemoryBoardBackend } from "../src/worker/store.js";

function envelope(id: string, name: string, extra: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    cli: "claude-code",
    cli_version: "test",
    event_id: id,
    event_name: name,
    occurred_at: "2026-01-01T00:00:00.000Z",
    sender_version: "test",
    session_id: "session-1",
    v: 1,
    ...extra,
  };
}

test("duplicate event ids do not duplicate events or session writes", () => {
  const backend = new MemoryBoardBackend();
  const service = new BoardService(backend);
  const event = envelope("event-1", "SessionStart");
  const first = service.ingest("machine-a", [event], "2026-01-01T00:00:00.000Z");
  const second = service.ingest("machine-a", [event], "2026-01-01T00:00:01.000Z");
  assert.equal(first.accepted, 1);
  assert.equal(second.duplicates, 1);
  assert.equal(service.recentEvents("session-1", 10).length, 1);
  assert.equal(backend.metrics.sessionWrites, 1);
});

test("a batch writes each changed session once", () => {
  const backend = new MemoryBoardBackend();
  const service = new BoardService(backend);
  const events = Array.from({ length: 200 }, (_, i) =>
    envelope(`pulse-${i}`, i % 2 ? "PostToolUse" : "PreToolUse", { tool_name: "Bash" }),
  );
  const result = service.ingest("machine-a", events, "2026-01-01T00:00:00.000Z");
  assert.equal(result.accepted, 200);
  assert.equal(backend.metrics.sessionWrites, 1);
  assert.equal(backend.metrics.eventWrites, 200);
  assert.equal(service.getSession("session-1")?.tool_pulses, 200);
});

test("no-change events do not write a session row before the last seen throttle", () => {
  const backend = new MemoryBoardBackend();
  const service = new BoardService(backend);
  service.ingest("machine-a", [envelope("event-1", "SessionStart")], "2026-01-01T00:00:00.000Z");
  const before = backend.metrics.sessionWrites;
  service.ingest("machine-a", [envelope("event-2", "SessionStart")], "2026-01-01T00:00:10.000Z");
  assert.equal(backend.metrics.sessionWrites, before);
  service.ingest("machine-a", [envelope("event-3", "SessionStart")], "2026-01-01T00:00:31.000Z");
  assert.equal(backend.metrics.sessionWrites, before + 1);
});

test("event windows are rings with per session and global caps", () => {
  const backend = new MemoryBoardBackend();
  const service = new BoardService(backend);
  const events = Array.from({ length: 205 }, (_, i) =>
    envelope(`event-${i}`, "PreToolUse", { pulse_count: 1, tool_name: "Bash" }),
  );
  service.ingest("machine-a", events, "2026-01-01T00:00:00.000Z");
  assert.equal(service.recentEvents("session-1", 500).length, 200);
});

test("retention pruning deletes rows", () => {
  const backend = new MemoryBoardBackend();
  const service = new BoardService(backend);
  service.ingest(
    "machine-a",
    [envelope("old-1", "SessionStart"), envelope("old-2", "SessionEnd")],
    "2026-01-01T00:00:00.000Z",
  );
  const pruned = service.prune(new Date("2026-03-01T00:00:00.000Z"), 7, 30);
  assert.equal(pruned.events, 2);
  assert.equal(pruned.sessions, 1);
  assert.equal(service.getSession("session-1"), null);
  assert.equal(service.recentEvents("session-1", 10).length, 0);
});

test("heartbeat writes are throttled", () => {
  const backend = new MemoryBoardBackend();
  const service = new BoardService(backend);
  assert.equal(
    service.heartbeat("machine-a", "test", 0, "2026-01-01T00:00:00.000Z").throttled,
    false,
  );
  assert.equal(
    service.heartbeat("machine-a", "test", 3, "2026-01-01T00:00:10.000Z").throttled,
    true,
  );
  assert.equal(backend.metrics.heartbeatWrites, 1);
  assert.equal(
    service.heartbeat("machine-a", "test", 3, "2026-01-01T00:00:31.000Z").throttled,
    false,
  );
});
