import { PERF } from "../shared/perf.js";
import type { BoardService } from "./store.js";

const TOOLS = [
  {
    description: "List current agent sessions with bounded pagination.",
    inputSchema: {
      properties: {
        limit: { maximum: PERF.mcpMaxLimit, minimum: 1, type: "number" },
        machine_id: { type: "string" },
        offset: { minimum: 0, type: "number" },
      },
      type: "object",
    },
    name: "list_sessions",
  },
  {
    description: "Get one agent session by id.",
    inputSchema: {
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
      type: "object",
    },
    name: "get_session",
  },
  {
    description: "Get recent stored events for one session with a hard limit.",
    inputSchema: {
      properties: {
        limit: { maximum: PERF.recentEventsMaxLimit, minimum: 1, type: "number" },
        session_id: { type: "string" },
      },
      required: ["session_id"],
      type: "object",
    },
    name: "get_recent_events",
  },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function result(id: unknown, value: unknown): Response {
  return json({ id, jsonrpc: "2.0", result: value });
}

function error(id: unknown, code: number, message: string): Response {
  return json({ error: { code, message }, id, jsonrpc: "2.0" });
}

function bounded(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ text: JSON.stringify(value), type: "text" }],
    structuredContent: isRecord(value) ? value : { value },
  };
}

export async function handleMcpRequest(request: Request, service: BoardService): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error(null, -32700, "parse error");
  }
  if (!isRecord(body) || typeof body.method !== "string") {
    return error(null, -32600, "invalid request");
  }
  const id = body.id ?? null;
  if (body.method === "notifications/initialized" || body.method === "notifications/cancelled") {
    return new Response(null, { status: 202 });
  }
  if (body.method === "initialize") {
    return result(id, {
      capabilities: { tools: {} },
      protocolVersion:
        isRecord(body.params) && typeof body.params.protocolVersion === "string"
          ? body.params.protocolVersion
          : "2025-03-26",
      serverInfo: { name: "agent-board", version: "0.1.0" },
    });
  }
  if (body.method === "ping") return result(id, {});
  if (body.method === "tools/list") return result(id, { tools: TOOLS });
  if (body.method !== "tools/call") return error(id, -32601, "method not found");
  const params = isRecord(body.params) ? body.params : {};
  const args = isRecord(params.arguments) ? params.arguments : {};
  const name = params.name;
  try {
    if (name === "list_sessions") {
      const limit = bounded(args.limit, PERF.mcpDefaultLimit, PERF.mcpMaxLimit);
      const offset = typeof args.offset === "number" ? Math.max(0, Math.floor(args.offset)) : 0;
      const machine = typeof args.machine_id === "string" ? args.machine_id : undefined;
      return result(id, toolResult({ sessions: service.listSessions(machine, limit, offset) }));
    }
    if (name === "get_session") {
      if (typeof args.session_id !== "string") return error(id, -32602, "session_id is required");
      const session = service.getSession(args.session_id);
      if (!session) return result(id, toolResult({ found: false, session: null }));
      return result(id, toolResult({ found: true, session }));
    }
    if (name === "get_recent_events") {
      if (typeof args.session_id !== "string") return error(id, -32602, "session_id is required");
      const limit = bounded(args.limit, PERF.recentEventsDefaultLimit, PERF.recentEventsMaxLimit);
      return result(id, toolResult({ events: service.recentEvents(args.session_id, limit) }));
    }
  } catch (caught) {
    return error(id, -32603, caught instanceof Error ? caught.message : "internal error");
  }
  return error(id, -32602, "unknown tool");
}
