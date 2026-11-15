import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { EventEnvelope, SessionRow } from "../src/shared/envelope.js";
import { parseEnvelope } from "../src/shared/envelope.js";
import { applyEvent } from "../src/shared/normalizer.js";
import { payloadToEnvelope } from "../src/sender/payload.js";

function fixture(name: string): unknown[] {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  );
  if (!Array.isArray(parsed)) throw new Error("fixture must be an array");
  return parsed;
}

function runFixture(name: string, cli: EventEnvelope["cli"]): SessionRow {
  let row: SessionRow | null = null;
  let index = 0;
  for (const raw of fixture(name)) {
    index += 1;
    const envelope = payloadToEnvelope(
      raw,
      "test",
      () => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      cli,
    );
    assert.equal(envelope.cli, cli);
    assert.equal("tool_input" in envelope, false);
    row = applyEvent(
      row,
      envelope,
      `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
      "machine-a",
    );
    if (envelope.event_name === "PermissionRequest") {
      assert.equal(row.attention, "needs_approval");
      assert.equal(row.attention_evidence?.event_name, "PermissionRequest");
    }
    if (envelope.event_name === "Notification" && cli === "codex") {
      assert.equal(row.attention, "needs_input");
    }
  }
  if (!row) throw new Error("fixture produced no row");
  return row;
}

test("claude fixture transitions to ended and rolls up subagents", () => {
  const row = runFixture("claude-session.json", "claude-code");
  assert.equal(row.lifecycle, "ended");
  assert.equal(row.activity, "idle");
  assert.equal(row.attention, "none");
  assert.equal(row.title, "Fix the demo parser and add a regression test");
  assert.equal(row.subagents.length, 1);
  assert.equal(row.subagents[0]?.status, "stopped");
  assert.equal(row.subagent_count, 0);
  assert.ok(row.tool_pulses >= 3);
});

test("codex fixture rolls subagents into the parent and clears input on prompt", () => {
  const row = runFixture("codex-session.json", "codex");
  assert.equal(row.lifecycle, "ended");
  assert.equal(row.subagents.length, 1);
  assert.equal(row.subagents[0]?.agent_id, "sub-codex-demo-1-1");
  assert.equal(row.attention, "none");
});

test("idle notification alone does not set attention", () => {
  const envelope: EventEnvelope = {
    cli: "claude-code",
    cli_version: "test",
    event_id: "idle-1",
    event_name: "Notification",
    notification_type: "idle_prompt",
    occurred_at: "2026-01-01T00:00:00.000Z",
    sender_version: "test",
    session_id: "idle-session",
    v: 1,
  };
  const row = applyEvent(null, envelope, "2026-01-01T00:00:00.000Z", "machine-a");
  assert.equal(row.attention, "none");
});

test("envelope parser rejects unsupported schema and bad pulse counts", () => {
  assert.throws(() => parseEnvelope({ v: 2 }), /v must be 1/);
  assert.throws(
    () =>
      parseEnvelope({
        cli: "claude-code",
        event_id: "x",
        event_name: "Stop",
        occurred_at: "2026-01-01T00:00:00.000Z",
        pulse_count: 0,
        session_id: "s",
        v: 1,
      }),
    /pulse_count/,
  );
});
