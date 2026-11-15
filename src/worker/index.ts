import { MAX_INGEST_BYTES } from "../shared/limits.js";
import { log } from "../shared/logger.js";
import { PERF } from "../shared/perf.js";
import {
  accessAuthorized,
  type AuthEnv,
  localBypass,
  machineFromToken,
  mcpAuthorized,
} from "./auth.js";
import { BoardDurableObject } from "./board-do.js";
import { DEMO_MACHINES, DEMO_SESSIONS } from "./demo.js";

export { BoardDurableObject };

interface DurableObjectId {
  toString(): string;
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectNamespace {
  get(id: DurableObjectId): DurableObjectStub;
  idFromName(name: string): DurableObjectId;
}

export interface Env extends AuthEnv {
  ASSETS?: { fetch(request: Request): Promise<Response> };
  BOARD: DurableObjectNamespace;
  EVENT_RETENTION_DAYS?: string;
  SESSION_RETENTION_DAYS?: string;
}

interface ScheduledController {
  cron: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function boardStub(env: Env): DurableObjectStub {
  return env.BOARD.get(env.BOARD.idFromName("global"));
}

async function forward(env: Env, path: string, request: Request, body?: string): Promise<Response> {
  const url = new URL(request.url);
  const target = `https://board.internal${path}${url.search}`;
  const headers = new Headers(request.headers);
  headers.delete("host");
  const init: RequestInit = { headers, method: request.method };
  if (body !== undefined) init.body = body;
  else if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
  return boardStub(env).fetch(new Request(target, init));
}

async function readBody(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > maxBytes) return null;
  const text = await request.text();
  return new TextEncoder().encode(text).byteLength > maxBytes ? null : text;
}

async function handleIngest(request: Request, env: Env): Promise<Response> {
  const machine = await machineFromToken(request, env);
  if (!machine) return json({ error: "unauthorized" }, 401);
  const text = await readBody(request, MAX_INGEST_BYTES);
  if (text === null) return json({ error: "payload too large" }, 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.events)) {
    return json({ error: "events array is required" }, 400);
  }
  if (parsed.events.length > PERF.ingestMaxEvents) {
    return json({ error: "too many events" }, 413);
  }
  const body = JSON.stringify({ events: parsed.events, machine_id: machine });
  return forward(env, "/internal/ingest", request, body);
}

async function handleHeartbeat(request: Request, env: Env): Promise<Response> {
  const machine = await machineFromToken(request, env);
  if (!machine) return json({ error: "unauthorized" }, 401);
  const text = await readBody(request, 4096);
  if (text === null) return json({ error: "payload too large" }, 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  if (!isRecord(parsed)) return json({ error: "invalid heartbeat" }, 400);
  return forward(
    env,
    "/internal/heartbeat",
    request,
    JSON.stringify({ ...parsed, machine_id: machine }),
  );
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === "/api/ingest" && request.method === "POST") {
    return handleIngest(request, env);
  }
  if (url.pathname === "/api/heartbeat" && request.method === "POST") {
    return handleHeartbeat(request, env);
  }
  if (url.pathname === "/mcp") {
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    if (!(await mcpAuthorized(request, env))) return json({ error: "unauthorized" }, 401);
    const text = await readBody(request, MAX_INGEST_BYTES);
    if (text === null) return json({ error: "payload too large" }, 413);
    return forward(env, "/internal/mcp", request, text);
  }
  if (!(await accessAuthorized(request, env))) return json({ error: "unauthorized" }, 401);
  if (url.searchParams.get("demo") === "1" && localBypass(env)) {
    if (url.pathname === "/api/sessions") return json({ sessions: DEMO_SESSIONS });
    if (url.pathname === "/api/machines") return json({ machines: DEMO_MACHINES });
  }
  if (url.pathname === "/api/demo/seed" && request.method === "POST" && localBypass(env)) {
    return forward(env, "/internal/demo-seed", request, "{}");
  }
  if (url.pathname === "/api/stream") return forward(env, "/internal/stream", request);
  if (url.pathname === "/api/sessions") return forward(env, "/internal/sessions", request);
  if (url.pathname === "/api/machines") return forward(env, "/internal/machines", request);
  if (url.pathname === "/api/resync") return forward(env, "/internal/resync", request);
  if (url.pathname === "/api/metrics") return forward(env, "/internal/metrics", request);
  const session = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (session) return forward(env, `/internal/sessions/${session[1]}`, request);
  const events = url.pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
  if (events) return forward(env, `/internal/sessions/${events[1]}/events`, request);
  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/") || url.pathname === "/mcp") {
        return await handleApi(request, env, url);
      }
      if (request.method === "GET" && env.ASSETS) {
        const asset = await env.ASSETS.fetch(request);
        if (asset.status !== 404) return asset;
        const indexUrl = new URL(request.url);
        indexUrl.pathname = "/index.html";
        return env.ASSETS.fetch(new Request(indexUrl, request));
      }
      return new Response("Agent Board", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    } catch (caught) {
      log("error", "worker request failed", {
        error: caught instanceof Error ? caught.message : String(caught),
      });
      return json({ error: "internal error" }, 500);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const body = JSON.stringify({
      event_retention_days: Number(env.EVENT_RETENTION_DAYS ?? PERF.eventRetentionDays),
      session_retention_days: Number(env.SESSION_RETENTION_DAYS ?? PERF.sessionRetentionDays),
    });
    await boardStub(env).fetch(
      new Request("https://board.internal/internal/prune", {
        body,
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
  },
};
