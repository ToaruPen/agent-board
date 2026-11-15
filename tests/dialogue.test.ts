import assert from "node:assert/strict";
import test from "node:test";
import type { PendingCommand } from "../src/shared/dialogue.js";
import type { EventEnvelope } from "../src/shared/envelope.js";
import { MESSAGE_LIMIT } from "../src/shared/limits.js";
import { PERF } from "../src/shared/perf.js";
import { type CliRunner, executeCommand, SessionActivityTracker } from "../src/sender/dialogue.js";
import { BoardService, MemoryBoardBackend } from "../src/worker/store.js";

const T0 = "2026-01-01T00:00:00.000Z";

function at(offsetMs: number): string {
  return new Date(Date.parse(T0) + offsetMs).toISOString();
}

let eventCounter = 0;

function envelope(name: string, extra: Partial<EventEnvelope> = {}): EventEnvelope {
  eventCounter += 1;
  return {
    cli: "claude-code",
    cli_version: "test",
    cwd: "/example/demo-repo",
    event_id: `event-${eventCounter}`,
    event_name: name,
    occurred_at: T0,
    sender_version: "test",
    session_id: "session-1",
    v: 1,
    ...extra,
  };
}

function setup(): { backend: MemoryBoardBackend; service: BoardService } {
  const backend = new MemoryBoardBackend();
  const service = new BoardService(backend);
  service.ingest("machine-a", [envelope("SessionStart")], T0);
  return { backend, service };
}

function actions(backend: MemoryBoardBackend, messageId: string): string[] {
  return backend.listAudit(messageId).map((entry) => `${entry.actor}:${entry.action}`);
}

test("a session message is offered, run, and answered with a truncated reply", () => {
  const { backend, service } = setup();
  const message = service.createMessage("session-1", "  status please  ", at(1));
  assert.equal(message.status, "queued");
  assert.equal(message.body, "status please");
  assert.equal(message.machine_id, "machine-a");
  const commands = service.offerCommands("machine-a", at(2));
  assert.deepEqual(commands, [
    {
      body: "status please",
      cli: "claude-code",
      cwd: "/example/demo-repo",
      message_id: message.message_id,
      session_id: "session-1",
    },
  ]);
  service.reportResult("machine-a", message.message_id, { status: "running" }, at(3));
  const outcome = service.reportResult(
    "machine-a",
    message.message_id,
    { reply: "x".repeat(MESSAGE_LIMIT + 50), status: "answered" },
    at(4),
  );
  assert.equal(outcome.message.status, "answered");
  assert.equal(outcome.replyMessage?.author, "agent");
  assert.equal(outcome.replyMessage?.body.length, MESSAGE_LIMIT);
  assert.equal(outcome.replyMessage?.reply_to, message.message_id);
  const thread = service.listThread("session-1", 100);
  assert.deepEqual(
    thread.map((row) => [row.author, row.status]),
    [
      ["pen", "answered"],
      ["agent", "answered"],
    ],
  );
  assert.deepEqual(actions(backend, message.message_id), [
    "pen:created",
    "machine-a:offered",
    "machine-a:running",
    "machine-a:answered",
  ]);
});

test("a held session waits for its board sequence to move, in message order", () => {
  const { service } = setup();
  const first = service.createMessage("session-1", "first", at(1));
  const second = service.createMessage("session-1", "second", at(1));
  assert.deepEqual(
    service.offerCommands("machine-a", at(2)).map((command) => command.message_id),
    [first.message_id],
  );
  assert.deepEqual(service.offerCommands("machine-a", at(3)), []);
  const held = service.reportResult(
    "machine-a",
    first.message_id,
    { reason: "session_busy", status: "held_busy" },
    at(4),
  );
  assert.equal(held.message.reason, "session_busy");
  assert.deepEqual(service.offerCommands("machine-a", at(5)), []);
  service.ingest(
    "machine-a",
    [envelope("UserPromptSubmit", { prompt: "next" }), envelope("Stop")],
    at(6),
  );
  assert.deepEqual(
    service.offerCommands("machine-a", at(7)).map((command) => command.message_id),
    [first.message_id],
  );
  service.reportResult("machine-a", first.message_id, { reply: "ok", status: "answered" }, at(8));
  assert.deepEqual(
    service.offerCommands("machine-a", at(9)).map((command) => command.message_id),
    [second.message_id],
  );
});

test("a held command is offered again after the retry delay without a session change", () => {
  const { service } = setup();
  const message = service.createMessage("session-1", "retry me", at(1));
  service.offerCommands("machine-a", at(2));
  service.reportResult("machine-a", message.message_id, { status: "held_busy" }, at(3));
  assert.deepEqual(service.offerCommands("machine-a", at(3 + PERF.dialogueHeldRetryMs - 1)), []);
  assert.equal(service.offerCommands("machine-a", at(3 + PERF.dialogueHeldRetryMs)).length, 1);
});

test("a queued message past its expiry is expired and never offered", () => {
  const { backend, service } = setup();
  const message = service.createMessage("session-1", "too late", at(0));
  assert.deepEqual(service.offerCommands("machine-a", at(PERF.dialogueExpiryMs)), []);
  assert.equal(service.listThread("session-1", 100)[0]?.status, "expired");
  assert.deepEqual(actions(backend, message.message_id), ["pen:created", "worker:expired"]);
});

test("a command stuck in flight is reclaimed and offered again", () => {
  const { service } = setup();
  const message = service.createMessage("session-1", "stuck", at(0));
  service.offerCommands("machine-a", at(1));
  const later = at(1 + PERF.dialogueExecTimeoutMs + 60_001);
  assert.deepEqual(
    service.offerCommands("machine-a", later).map((command) => command.message_id),
    [message.message_id],
  );
});

test("results from another machine or out of order are rejected", () => {
  const { service } = setup();
  const message = service.createMessage("session-1", "hello", at(1));
  assert.throws(
    () => service.reportResult("machine-a", message.message_id, { status: "running" }, at(2)),
    /invalid transition/,
  );
  service.offerCommands("machine-a", at(2));
  assert.throws(
    () => service.reportResult("machine-b", message.message_id, { status: "running" }, at(3)),
    /another machine/,
  );
  assert.throws(
    () => service.reportResult("machine-a", "missing", { status: "running" }, at(3)),
    /message not found/,
  );
  service.reportResult("machine-a", message.message_id, { status: "failed", reason: "x" }, at(4));
  assert.throws(
    () => service.reportResult("machine-a", message.message_id, { status: "answered" }, at(5)),
    /invalid transition/,
  );
});

test("message creation validates the body and the session", () => {
  const { service } = setup();
  assert.throws(() => service.createMessage("session-1", "   ", at(1)), /message body is empty/);
  assert.throws(
    () => service.createMessage("session-1", "x".repeat(PERF.dialogueMessageMaxChars + 1), at(1)),
    /message too long/,
  );
  assert.throws(() => service.createMessage("unknown", "hello", at(1)), /session not found/);
});

test("the Muse thread is served by the inbox and answered by a Muse reply", () => {
  const { backend, service } = setup();
  const message = service.createMessage("muse", "テスト相談", at(1));
  assert.equal(message.machine_id, null);
  assert.deepEqual(service.offerCommands("machine-a", at(2)), []);
  assert.deepEqual(
    service.museInbox(at(2)).map((row) => row.message_id),
    [message.message_id],
  );
  const outcome = service.museReply(message.message_id, "y".repeat(MESSAGE_LIMIT + 10), at(3));
  assert.equal(outcome.message.status, "answered");
  assert.equal(outcome.replyMessage?.author, "muse");
  assert.equal(outcome.replyMessage?.body.length, MESSAGE_LIMIT);
  assert.deepEqual(service.museInbox(at(4)), []);
  assert.throws(() => service.museReply(message.message_id, "again", at(5)), /invalid transition/);
  assert.deepEqual(actions(backend, message.message_id), ["pen:created", "muse:answered"]);
  assert.deepEqual(actions(backend, outcome.replyMessage?.message_id ?? ""), ["muse:replied"]);
});

test("a thread keeps at most the cap by pruning terminal messages", () => {
  const { backend, service } = setup();
  for (let i = 0; i < PERF.dialogueThreadCap + 5; i += 1) {
    const message = service.createMessage("session-1", `message ${i}`, at(i));
    backend.putMessage({ ...message, status: "answered" });
  }
  assert.equal(backend.countMessages("session-1"), PERF.dialogueThreadCap);
  assert.equal(service.listThread("session-1", 1000)[0]?.body, "message 5");
});

test("retention pruning deletes old terminal messages and keeps waiting ones", () => {
  const { backend, service } = setup();
  const message = service.createMessage("muse", "old", T0);
  service.museReply(message.message_id, "done", T0);
  const pending = service.createMessage("muse", "still waiting", T0);
  const pruned = service.prune(new Date("2026-03-01T00:00:00.000Z"), 7, 30);
  assert.equal(pruned.messages, 2);
  assert.deepEqual(backend.listAudit(message.message_id), []);
  assert.deepEqual(
    service.listThread("muse", 100).map((row) => row.message_id),
    [pending.message_id],
  );
});

test("the activity tracker vetoes only sessions it knows are mid turn", () => {
  const tracker = new SessionActivityTracker();
  assert.equal(tracker.isSafe("session-1"), null);
  tracker.observe(envelope("SessionStart"));
  assert.equal(tracker.isSafe("session-1"), true);
  assert.equal(tracker.observe(envelope("UserPromptSubmit")), true);
  assert.equal(tracker.isSafe("session-1"), false);
  assert.equal(tracker.observe(envelope("PreToolUse")), false);
  tracker.observe(envelope("Stop"));
  assert.equal(tracker.isSafe("session-1"), true);
  tracker.observe(envelope("PreToolUse", { session_id: "session-2" }));
  assert.equal(tracker.isSafe("session-2"), false);
  tracker.observe(envelope("SessionEnd", { session_id: "session-2" }));
  assert.equal(tracker.isSafe("session-2"), true);
  const restored = SessionActivityTracker.fromJSON(JSON.parse(JSON.stringify(tracker)));
  assert.deepEqual(restored.toJSON(), tracker.toJSON());
  assert.equal(restored.isSafe("session-2"), true);
});

function command(cli: PendingCommand["cli"]): PendingCommand {
  return {
    body: "進捗を一文で教えて",
    cli,
    cwd: "/example/does-not-exist",
    message_id: "message-1",
    session_id: "session-1",
  };
}

function fakeRunner(
  result: Partial<Awaited<ReturnType<CliRunner>>>,
  calls: Array<{ args: string[]; bin: string }> = [],
): CliRunner {
  return async (bin, args) => {
    calls.push({ args, bin });
    return { code: 0, stderr: "", stdout: "", timedOut: false, ...result };
  };
}

test("the executor maps CLI outcomes to command results", async () => {
  const calls: Array<{ args: string[]; bin: string }> = [];
  const answered = await executeCommand(command("claude-code"), {
    claudeBin: "fake-claude",
    run: fakeRunner({ stdout: " 進捗は良好です。\n" }, calls),
  });
  assert.deepEqual(answered, { reply: "進捗は良好です。", status: "answered" });
  assert.equal(calls[0]?.bin, "fake-claude");
  assert.ok(calls[0]?.args.includes("--resume"));
  assert.ok(calls[0]?.args.includes("-p"));

  const held = await executeCommand(command("codex"), {
    codexBin: "fake-codex",
    run: fakeRunner(
      { code: 1, stderr: "boot\nthread-store conflict: session already has an active writer\n" },
      calls,
    ),
  });
  assert.equal(held.status, "held_busy");
  assert.equal(held.reason, "thread-store conflict: session already has an active writer");
  assert.ok(calls[1]?.args.includes("exec"));
  assert.ok(calls[1]?.args.includes("resume"));

  const failed = await executeCommand(command("claude-code"), {
    run: fakeRunner({ code: 1, stderr: "session not found" }),
  });
  assert.deepEqual(failed, { reason: "session not found", status: "failed" });

  const empty = await executeCommand(command("claude-code"), { run: fakeRunner({}) });
  assert.deepEqual(empty, { reason: "empty_reply", status: "failed" });

  const timedOut = await executeCommand(command("claude-code"), {
    run: fakeRunner({ code: null, timedOut: true }),
  });
  assert.deepEqual(timedOut, { reason: "timeout", status: "failed" });
});
