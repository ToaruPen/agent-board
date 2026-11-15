import { type CommandResult, MUSE_THREAD_ID } from "../shared/dialogue.js";
import { parseEnvelope } from "../shared/envelope.js";
import { PERF } from "../shared/perf.js";
import { DEMO_MACHINES, DEMO_SESSIONS } from "./demo.js";
import { handleMcpRequest } from "./mcp.js";
import { BoardService, SqlBoardBackend, type SqlStorage } from "./store.js";

export interface DurableObjectState {
  acceptWebSocket(socket: WebSocket): void;
  getWebSockets(): WebSocket[];
  storage: { sql: SqlStorage };
}

interface WebSocketPairConstructor {
  new (): { 0: WebSocket; 1: WebSocket };
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

const DIALOGUE_ERROR_STATUS: Record<string, number> = {
  "invalid dialogue body": 400,
  "invalid transition": 409,
  "message belongs to another machine": 403,
  "message body is empty": 400,
  "message not found": 404,
  "message too long": 400,
  "session not found": 404,
};

function dialogueError(caught: unknown): Response | null {
  const message = caught instanceof Error ? caught.message : "";
  const status = DIALOGUE_ERROR_STATUS[message];
  return status ? json({ error: message }, status) : null;
}

async function dialogueBody(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body)) throw new Error("invalid dialogue body");
  return body;
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid dialogue body");
  return value;
}

function commandResult(body: Record<string, unknown>): CommandResult {
  const status = body.status;
  if (
    status !== "answered" &&
    status !== "failed" &&
    status !== "held_busy" &&
    status !== "running"
  ) {
    throw new Error("invalid dialogue body");
  }
  const result: CommandResult = { status };
  if (typeof body.reply === "string") result.reply = body.reply;
  if (typeof body.reason === "string") result.reason = body.reason;
  return result;
}

function bounded(value: string | null, fallback: number, max: number): number {
  const parsed = value ? Number(value) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

export class BoardDurableObject {
  private readonly backend: SqlBoardBackend;
  private readonly service: BoardService;
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.backend = new SqlBoardBackend(state.storage.sql);
    this.service = new BoardService(this.backend);
  }

  private broadcastSession(session: ReturnType<BoardService["listSessions"]>[number]): void {
    const payload = JSON.stringify({
      session,
      sequence: session.board_seq,
      type: "session",
    });
    for (const socket of this.state.getWebSockets()) {
      try {
        socket.send(payload);
        this.backend.metrics.broadcasts += 1;
      } catch {
        try {
          socket.close(1011, "send failed");
        } catch {
          // The socket is already gone. Other sockets still receive the row.
        }
      }
    }
  }

  private broadcastThread(threadId: string): void {
    const payload = JSON.stringify({ thread_id: threadId, type: "thread" });
    for (const socket of this.state.getWebSockets()) {
      try {
        socket.send(payload);
        this.backend.metrics.broadcasts += 1;
      } catch {
        try {
          socket.close(1011, "send failed");
        } catch {
          // The socket is already gone. Other sockets still receive the notice.
        }
      }
    }
  }

  private async dialogue(request: Request, url: URL): Promise<Response | null> {
    const threadMatch = url.pathname.match(/^\/internal\/sessions\/([^/]+)\/messages$/);
    const threadId = threadMatch
      ? decodeURIComponent(threadMatch[1] as string)
      : url.pathname === "/internal/muse/messages"
        ? MUSE_THREAD_ID
        : null;
    if (threadId !== null && request.method === "POST") {
      const body = await dialogueBody(request);
      const message = this.service.createMessage(threadId, text(body.body));
      this.broadcastThread(threadId);
      return json({ message }, 201);
    }
    if (threadId !== null && request.method === "GET") {
      const limit = bounded(
        url.searchParams.get("limit"),
        PERF.dialogueThreadCap,
        PERF.dialogueThreadCap,
      );
      return json({ messages: this.service.listThread(threadId, limit) });
    }
    if (url.pathname === "/internal/muse/inbox" && request.method === "GET") {
      return json({ messages: this.service.museInbox() });
    }
    if (url.pathname === "/internal/muse/reply" && request.method === "POST") {
      const body = await dialogueBody(request);
      const outcome = this.service.museReply(text(body.message_id), text(body.body));
      this.broadcastThread(MUSE_THREAD_ID);
      return json(outcome);
    }
    const resultMatch = url.pathname.match(/^\/internal\/commands\/([^/]+)\/result$/);
    if (resultMatch && request.method === "POST") {
      const body = await dialogueBody(request);
      const outcome = this.service.reportResult(
        text(body.machine_id),
        decodeURIComponent(resultMatch[1] as string),
        commandResult(body),
      );
      this.broadcastThread(outcome.message.thread_id);
      return json(outcome);
    }
    return null;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      const dialogue = await this.dialogue(request, url).catch((caught: unknown) => {
        const mapped = dialogueError(caught);
        if (mapped) return mapped;
        throw caught;
      });
      if (dialogue) return dialogue;
      if (url.pathname === "/internal/stream") {
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
          return json({ error: "websocket upgrade required" }, 426);
        }
        const Pair = (globalThis as unknown as { WebSocketPair: WebSocketPairConstructor })
          .WebSocketPair;
        const pair = new Pair();
        const client = pair[0];
        const server = pair[1];
        this.state.acceptWebSocket(server);
        server.send(
          JSON.stringify({
            machines: this.service.listMachines(),
            sequence: this.service.metrics().sequence,
            sessions: this.service.listSessions(undefined, PERF.readMaxLimit, 0),
            type: "snapshot",
          }),
        );
        this.backend.metrics.broadcasts += 1;
        return new Response(null, {
          status: 101,
          webSocket: client,
        } as unknown as ResponseInit);
      }
      if (url.pathname === "/internal/mcp") return handleMcpRequest(request, this.service);
      if (url.pathname === "/internal/ingest" && request.method === "POST") {
        const body: unknown = await request.json();
        if (!isRecord(body) || typeof body.machine_id !== "string" || !Array.isArray(body.events)) {
          return json({ error: "invalid ingest body" }, 400);
        }
        if (body.events.length > PERF.ingestMaxEvents) {
          return json({ error: "too many events" }, 413);
        }
        const envelopes = body.events.map((event) => parseEnvelope(event));
        const outcome = this.service.ingest(body.machine_id, envelopes);
        for (const session of outcome.changed) this.broadcastSession(session);
        return json({ ...outcome, metrics: this.service.metrics() });
      }
      if (url.pathname === "/internal/heartbeat" && request.method === "POST") {
        const body: unknown = await request.json();
        if (!isRecord(body) || typeof body.machine_id !== "string") {
          return json({ error: "invalid heartbeat body" }, 400);
        }
        const outcome = this.service.heartbeat(
          body.machine_id,
          typeof body.sender_version === "string" ? body.sender_version : "unknown",
          typeof body.spool_depth === "number" ? Math.max(0, Math.floor(body.spool_depth)) : 0,
        );
        for (const command of outcome.commands) this.broadcastThread(command.session_id);
        return json(outcome);
      }
      if (url.pathname === "/internal/sessions" && request.method === "GET") {
        const limit = bounded(
          url.searchParams.get("limit"),
          PERF.readDefaultLimit,
          PERF.readMaxLimit,
        );
        const offsetRaw = Number(url.searchParams.get("offset") ?? 0);
        const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : 0;
        return json({
          sessions: this.service.listSessions(
            url.searchParams.get("machine_id") ?? undefined,
            limit,
            offset,
          ),
        });
      }
      const sessionMatch = url.pathname.match(/^\/internal\/sessions\/([^/]+)$/);
      if (sessionMatch && request.method === "GET") {
        const session = this.service.getSession(decodeURIComponent(sessionMatch[1] as string));
        return session ? json({ session }) : json({ error: "session not found" }, 404);
      }
      const eventsMatch = url.pathname.match(/^\/internal\/sessions\/([^/]+)\/events$/);
      if (eventsMatch && request.method === "GET") {
        const limit = bounded(
          url.searchParams.get("limit"),
          PERF.recentEventsDefaultLimit,
          PERF.recentEventsMaxLimit,
        );
        return json({
          events: this.service.recentEvents(decodeURIComponent(eventsMatch[1] as string), limit),
        });
      }
      if (url.pathname === "/internal/machines")
        return json({ machines: this.service.listMachines() });
      if (url.pathname === "/internal/resync") {
        const since = Number(url.searchParams.get("since") ?? 0);
        return json(this.service.resync(Number.isFinite(since) ? since : 0));
      }
      if (url.pathname === "/internal/metrics") return json({ metrics: this.service.metrics() });
      if (url.pathname === "/internal/prune" && request.method === "POST") {
        const body: unknown = await request.json().catch(() => ({}));
        const record = isRecord(body) ? body : {};
        const eventDays: number =
          typeof record.event_retention_days === "number"
            ? record.event_retention_days
            : PERF.eventRetentionDays;
        const sessionDays: number =
          typeof record.session_retention_days === "number"
            ? record.session_retention_days
            : PERF.sessionRetentionDays;
        return json({ pruned: this.service.prune(new Date(), eventDays, sessionDays) });
      }
      if (url.pathname === "/internal/demo-seed" && request.method === "POST") {
        for (const machine of DEMO_MACHINES) this.service.seedMachine(machine);
        for (const session of DEMO_SESSIONS) this.service.seedSession(session);
        return json({ seeded: true });
      }
      return json({ error: "not found" }, 404);
    } catch (caught) {
      return json(
        { error: caught instanceof Error ? caught.message : "internal error" },
        caught instanceof Error && caught.message.includes("envelope") ? 400 : 500,
      );
    }
  }

  webSocketMessage(_socket: WebSocket, _message: string | ArrayBuffer): void {
    return;
  }

  webSocketClose(_socket: WebSocket): void {
    return;
  }
}
