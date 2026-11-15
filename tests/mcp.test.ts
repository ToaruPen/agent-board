import assert from "node:assert/strict";
import test from "node:test";
import type { EventEnvelope } from "../src/shared/envelope.js";
import { handleMcpRequest } from "../src/worker/mcp.js";
import { BoardService, MemoryBoardBackend } from "../src/worker/store.js";

function service(): BoardService {
  const board = new BoardService(new MemoryBoardBackend());
  const event: EventEnvelope = {
    cli: "codex",
    cli_version: "test",
    event_id: "mcp-1",
    event_name: "UserPromptSubmit",
    occurred_at: "2026-01-01T00:00:00.000Z",
    prompt: "Write the demo docs",
    sender_version: "test",
    session_id: "mcp-session",
    v: 1,
  };
  board.ingest("machine-a", [event], "2026-01-01T00:00:00.000Z");
  return board;
}

async function call(board: BoardService, body: unknown): Promise<Record<string, unknown>> {
  const response = await handleMcpRequest(
    new Request("https://example.invalid/mcp", {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    board,
  );
  const parsed: unknown = await response.json();
  if (typeof parsed !== "object" || parsed === null) throw new Error("bad MCP response");
  return parsed as Record<string, unknown>;
}

test("MCP lists tools and answers session queries", async () => {
  const board = service();
  const init = await call(board, { id: 1, jsonrpc: "2.0", method: "initialize", params: {} });
  assert.ok(init.result);
  const list = await call(board, { id: 2, jsonrpc: "2.0", method: "tools/list" });
  const tools = (list.result as { tools: Array<{ name: string }> }).tools;
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["list_sessions", "get_session", "get_recent_events"],
  );
  const got = await call(board, {
    id: 3,
    jsonrpc: "2.0",
    method: "tools/call",
    params: { arguments: { session_id: "mcp-session" }, name: "get_session" },
  });
  const result = got.result as { structuredContent: { session: { title: string } } };
  assert.equal(result.structuredContent.session.title, "Write the demo docs");
  const events = await call(board, {
    id: 4,
    jsonrpc: "2.0",
    method: "tools/call",
    params: {
      arguments: { limit: 9999, session_id: "mcp-session" },
      name: "get_recent_events",
    },
  });
  const eventResult = events.result as { structuredContent: { events: unknown[] } };
  assert.equal(eventResult.structuredContent.events.length, 1);
});
