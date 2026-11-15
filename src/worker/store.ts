import {
  type AuditEntry,
  type CommandResult,
  type DialogueMessage,
  type DialogueStatus,
  MUSE_THREAD_ID,
  type PendingCommand,
  TERMINAL_STATUSES,
} from "../shared/dialogue.js";
import type { MachineRow, SessionRow, StoredEvent } from "../shared/envelope.js";
import { parseEnvelope } from "../shared/envelope.js";
import { newMessageId } from "../shared/ids.js";
import { MESSAGE_LIMIT, truncate } from "../shared/limits.js";
import { applyEvent, NORMALIZER_VERSION } from "../shared/normalizer.js";
import { PERF } from "../shared/perf.js";

export const WORKER_PERF = PERF;

export interface StoreMetrics {
  broadcasts: number;
  eventWrites: number;
  heartbeatWrites: number;
  ingestRequests: number;
  sessionWrites: number;
}

export interface PruneCounts {
  events: number;
  messages: number;
  sessions: number;
}

export interface BoardBackend {
  readonly metrics: StoreMetrics;
  addAudit(entry: Omit<AuditEntry, "audit_id">): void;
  addEvent(event: StoredEvent): void;
  addMessage(message: DialogueMessage): void;
  countEvents(): number;
  countMessages(threadId: string): number;
  countSessions(): number;
  deleteMessages(messageIds: string[]): void;
  deleteOldestEvents(keep: number, sessionId?: string): number;
  deleteOldestSessions(keep: number): number;
  getMachine(machineId: string): MachineRow | null;
  getMessage(messageId: string): DialogueMessage | null;
  getSession(sessionId: string): SessionRow | null;
  hasEvent(eventId: string): boolean;
  listAudit(messageId: string): AuditEntry[];
  listEvents(sessionId: string, limit: number): StoredEvent[];
  listMachines(): MachineRow[];
  listMessages(threadId: string, limit: number): DialogueMessage[];
  // Oldest first. A null machine selects the Muse thread, the only thread without a machine.
  listMessagesByStatus(machineId: string | null, statuses: DialogueStatus[]): DialogueMessage[];
  listSessions(machineId: string | undefined, limit: number, offset: number): SessionRow[];
  listSessionsSince(sequence: number): SessionRow[];
  nextSequence(): number;
  prune(eventCutoff: string, endedCutoff: string): PruneCounts;
  putMachine(machine: MachineRow): void;
  putMessage(message: DialogueMessage): void;
  putSession(session: SessionRow): void;
  sequence(): number;
}

function isTerminal(status: DialogueStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class MemoryBoardBackend implements BoardBackend {
  readonly metrics: StoreMetrics = {
    broadcasts: 0,
    eventWrites: 0,
    heartbeatWrites: 0,
    ingestRequests: 0,
    sessionWrites: 0,
  };
  private readonly audit: AuditEntry[] = [];
  private currentSequence = 0;
  private readonly events: StoredEvent[] = [];
  private readonly machines = new Map<string, MachineRow>();
  private readonly messages = new Map<string, DialogueMessage>();
  private nextAuditId = 1;
  private readonly sessions = new Map<string, SessionRow>();

  addAudit(entry: Omit<AuditEntry, "audit_id">): void {
    this.audit.push({ ...entry, audit_id: this.nextAuditId });
    this.nextAuditId += 1;
  }

  addEvent(event: StoredEvent): void {
    this.events.push(clone(event));
    this.metrics.eventWrites += 1;
  }

  addMessage(message: DialogueMessage): void {
    if (this.messages.has(message.message_id)) throw new Error("message already exists");
    this.messages.set(message.message_id, clone(message));
  }

  countMessages(threadId: string): number {
    return this.threadMessages(threadId).length;
  }

  deleteMessages(messageIds: string[]): void {
    const ids = new Set(messageIds);
    for (const id of ids) this.messages.delete(id);
    const kept = this.audit.filter((entry) => !ids.has(entry.message_id));
    this.audit.splice(0, this.audit.length, ...kept);
  }

  getMessage(messageId: string): DialogueMessage | null {
    const row = this.messages.get(messageId);
    return row ? clone(row) : null;
  }

  listAudit(messageId: string): AuditEntry[] {
    return clone(this.audit.filter((entry) => entry.message_id === messageId));
  }

  listMessages(threadId: string, limit: number): DialogueMessage[] {
    return clone(this.threadMessages(threadId).slice(-limit));
  }

  listMessagesByStatus(machineId: string | null, statuses: DialogueStatus[]): DialogueMessage[] {
    return clone(
      this.ordered().filter((row) => row.machine_id === machineId && statuses.includes(row.status)),
    );
  }

  putMessage(message: DialogueMessage): void {
    this.messages.set(message.message_id, clone(message));
  }

  // Array.sort is stable, so equal timestamps keep insertion order like the SQL rowid tie break.
  private ordered(): DialogueMessage[] {
    return [...this.messages.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  private threadMessages(threadId: string): DialogueMessage[] {
    return this.ordered().filter((row) => row.thread_id === threadId);
  }

  countEvents(): number {
    return this.events.length;
  }

  countSessions(): number {
    return this.sessions.size;
  }

  deleteOldestEvents(keep: number, sessionId?: string): number {
    const matching = this.events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => !sessionId || event.envelope.session_id === sessionId)
      .sort((a, b) => b.index - a.index);
    const remove = new Set(matching.slice(keep).map(({ index }) => index));
    const before = this.events.length;
    const kept = this.events.filter((_, index) => !remove.has(index));
    this.events.splice(0, this.events.length, ...kept);
    return before - this.events.length;
  }

  deleteOldestSessions(keep: number): number {
    if (this.sessions.size <= keep) return 0;
    const rows = [...this.sessions.values()].sort((a, b) =>
      a.last_event_at.localeCompare(b.last_event_at),
    );
    let deleted = 0;
    for (const row of rows) {
      if (this.sessions.size <= keep) break;
      if (row.lifecycle === "active") continue;
      this.sessions.delete(row.session_id);
      deleted += 1;
    }
    return deleted;
  }

  getMachine(machineId: string): MachineRow | null {
    const row = this.machines.get(machineId);
    return row ? clone(row) : null;
  }

  getSession(sessionId: string): SessionRow | null {
    const row = this.sessions.get(sessionId);
    return row ? clone(row) : null;
  }

  hasEvent(eventId: string): boolean {
    return this.events.some((event) => event.envelope.event_id === eventId);
  }

  listEvents(sessionId: string, limit: number): StoredEvent[] {
    return clone(
      this.events.filter((event) => event.envelope.session_id === sessionId).slice(-limit),
    );
  }

  listMachines(): MachineRow[] {
    return clone([...this.machines.values()]);
  }

  listSessions(machineId: string | undefined, limit: number, offset: number): SessionRow[] {
    return clone(
      [...this.sessions.values()]
        .filter((row) => !machineId || row.machine_id === machineId)
        .sort((a, b) => b.last_event_at.localeCompare(a.last_event_at))
        .slice(offset, offset + limit),
    );
  }

  listSessionsSince(sequence: number): SessionRow[] {
    return clone(
      [...this.sessions.values()]
        .filter((row) => row.board_seq > sequence)
        .sort((a, b) => a.board_seq - b.board_seq),
    );
  }

  nextSequence(): number {
    this.currentSequence += 1;
    return this.currentSequence;
  }

  prune(eventCutoff: string, endedCutoff: string): PruneCounts {
    const beforeEvents = this.events.length;
    const keptEvents = this.events.filter((event) => event.received_at >= eventCutoff);
    this.events.splice(0, this.events.length, ...keptEvents);
    let sessions = 0;
    for (const row of [...this.sessions.values()]) {
      if (row.lifecycle !== "active" && row.last_event_at < endedCutoff) {
        this.sessions.delete(row.session_id);
        sessions += 1;
      }
    }
    const staleMessages = [...this.messages.values()]
      .filter((row) => isTerminal(row.status) && row.updated_at < endedCutoff)
      .map((row) => row.message_id);
    this.deleteMessages(staleMessages);
    return { events: beforeEvents - keptEvents.length, messages: staleMessages.length, sessions };
  }

  putMachine(machine: MachineRow): void {
    this.machines.set(machine.machine_id, clone(machine));
    this.metrics.heartbeatWrites += 1;
  }

  putSession(session: SessionRow): void {
    this.sessions.set(session.session_id, clone(session));
    this.metrics.sessionWrites += 1;
  }

  sequence(): number {
    return this.currentSequence;
  }
}

export interface SqlCursor<T> {
  toArray(): T[];
}

export interface SqlStorage {
  exec<T = Record<string, unknown>>(query: string, ...params: unknown[]): SqlCursor<T>;
}

interface CountRow {
  count: number;
}

interface EventRow {
  board_seq: number;
  envelope_json: string;
  machine_id: string;
  received_at: string;
}

interface KeyValueRow {
  value: string;
}

interface AuditRow {
  audit_id: number;
  row_json: string;
}

export class SqlBoardBackend implements BoardBackend {
  readonly metrics: StoreMetrics = {
    broadcasts: 0,
    eventWrites: 0,
    heartbeatWrites: 0,
    ingestRequests: 0,
    sessionWrites: 0,
  };
  private readonly sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.sql = sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, lifecycle TEXT NOT NULL, last_event_at TEXT NOT NULL, board_seq INTEGER NOT NULL, row_json TEXT NOT NULL)",
    );
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS sessions_machine ON sessions (machine_id, last_event_at DESC)",
    );
    this.sql.exec("CREATE INDEX IF NOT EXISTS sessions_sequence ON sessions (board_seq)");
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS events (internal_id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL, board_seq INTEGER NOT NULL, received_at TEXT NOT NULL, machine_id TEXT NOT NULL, envelope_json TEXT NOT NULL)",
    );
    this.sql.exec("CREATE INDEX IF NOT EXISTS events_session ON events (session_id, internal_id)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS events_received ON events (received_at)");
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS machines (machine_id TEXT PRIMARY KEY, row_json TEXT NOT NULL)",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS messages (message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, session_id TEXT, machine_id TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, row_json TEXT NOT NULL)",
    );
    this.sql.exec("CREATE INDEX IF NOT EXISTS messages_thread ON messages (thread_id, created_at)");
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS messages_machine_status ON messages (machine_id, status)",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS audit (audit_id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, at TEXT NOT NULL, row_json TEXT NOT NULL)",
    );
    this.sql.exec("CREATE INDEX IF NOT EXISTS audit_message ON audit (message_id)");
  }

  addAudit(entry: Omit<AuditEntry, "audit_id">): void {
    this.sql.exec(
      "INSERT INTO audit (message_id, at, row_json) VALUES (?, ?, ?)",
      entry.message_id,
      entry.at,
      JSON.stringify(entry),
    );
  }

  addMessage(message: DialogueMessage): void {
    this.sql.exec(
      "INSERT INTO messages (message_id, thread_id, session_id, machine_id, status, created_at, updated_at, row_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      message.message_id,
      message.thread_id,
      message.session_id,
      message.machine_id,
      message.status,
      message.created_at,
      message.updated_at,
      JSON.stringify(message),
    );
  }

  countMessages(threadId: string): number {
    return (
      this.sql
        .exec<CountRow>("SELECT COUNT(*) AS count FROM messages WHERE thread_id = ?", threadId)
        .toArray()[0]?.count ?? 0
    );
  }

  deleteMessages(messageIds: string[]): void {
    for (const messageId of messageIds) {
      this.sql.exec("DELETE FROM audit WHERE message_id = ?", messageId);
      this.sql.exec("DELETE FROM messages WHERE message_id = ?", messageId);
    }
  }

  getMessage(messageId: string): DialogueMessage | null {
    const row = this.sql
      .exec<KeyValueRow>("SELECT row_json AS value FROM messages WHERE message_id = ?", messageId)
      .toArray()[0];
    return row ? (JSON.parse(row.value) as DialogueMessage) : null;
  }

  listAudit(messageId: string): AuditEntry[] {
    return this.sql
      .exec<AuditRow>(
        "SELECT audit_id, row_json FROM audit WHERE message_id = ? ORDER BY audit_id ASC",
        messageId,
      )
      .toArray()
      .map((row) => ({ ...(JSON.parse(row.row_json) as AuditEntry), audit_id: row.audit_id }));
  }

  listMessages(threadId: string, limit: number): DialogueMessage[] {
    return this.sql
      .exec<KeyValueRow>(
        "SELECT row_json AS value FROM messages WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
        threadId,
        limit,
      )
      .toArray()
      .reverse()
      .map((row) => JSON.parse(row.value) as DialogueMessage);
  }

  listMessagesByStatus(machineId: string | null, statuses: DialogueStatus[]): DialogueMessage[] {
    if (!statuses.length) return [];
    const placeholders = statuses.map(() => "?").join(", ");
    return this.sql
      .exec<KeyValueRow>(
        `SELECT row_json AS value FROM messages WHERE machine_id IS ? AND status IN (${placeholders}) ORDER BY created_at ASC, rowid ASC`,
        machineId,
        ...statuses,
      )
      .toArray()
      .map((row) => JSON.parse(row.value) as DialogueMessage);
  }

  putMessage(message: DialogueMessage): void {
    this.sql.exec(
      "INSERT INTO messages (message_id, thread_id, session_id, machine_id, status, created_at, updated_at, row_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(message_id) DO UPDATE SET thread_id = excluded.thread_id, session_id = excluded.session_id, machine_id = excluded.machine_id, status = excluded.status, created_at = excluded.created_at, updated_at = excluded.updated_at, row_json = excluded.row_json",
      message.message_id,
      message.thread_id,
      message.session_id,
      message.machine_id,
      message.status,
      message.created_at,
      message.updated_at,
      JSON.stringify(message),
    );
  }

  addEvent(event: StoredEvent): void {
    this.sql.exec(
      "INSERT INTO events (event_id, session_id, board_seq, received_at, machine_id, envelope_json) VALUES (?, ?, ?, ?, ?, ?)",
      event.envelope.event_id,
      event.envelope.session_id,
      event.board_seq,
      event.received_at,
      event.machine_id,
      JSON.stringify(event.envelope),
    );
    this.metrics.eventWrites += 1;
  }

  countEvents(): number {
    return this.sql.exec<CountRow>("SELECT COUNT(*) AS count FROM events").toArray()[0]?.count ?? 0;
  }

  countSessions(): number {
    return (
      this.sql.exec<CountRow>("SELECT COUNT(*) AS count FROM sessions").toArray()[0]?.count ?? 0
    );
  }

  deleteOldestEvents(keep: number, sessionId?: string): number {
    const before = this.countEvents();
    if (sessionId) {
      this.sql.exec(
        "DELETE FROM events WHERE session_id = ? AND internal_id NOT IN (SELECT internal_id FROM events WHERE session_id = ? ORDER BY internal_id DESC LIMIT ?)",
        sessionId,
        sessionId,
        keep,
      );
    } else {
      this.sql.exec(
        "DELETE FROM events WHERE internal_id NOT IN (SELECT internal_id FROM events ORDER BY internal_id DESC LIMIT ?)",
        keep,
      );
    }
    return before - this.countEvents();
  }

  deleteOldestSessions(keep: number): number {
    const before = this.countSessions();
    if (before <= keep) return 0;
    this.sql.exec(
      "DELETE FROM sessions WHERE lifecycle != 'active' AND session_id IN (SELECT session_id FROM sessions WHERE lifecycle != 'active' ORDER BY last_event_at ASC LIMIT ?)",
      before - keep,
    );
    return before - this.countSessions();
  }

  getMachine(machineId: string): MachineRow | null {
    const row = this.sql
      .exec<KeyValueRow>("SELECT row_json AS value FROM machines WHERE machine_id = ?", machineId)
      .toArray()[0];
    return row ? (JSON.parse(row.value) as MachineRow) : null;
  }

  getSession(sessionId: string): SessionRow | null {
    const row = this.sql
      .exec<KeyValueRow>("SELECT row_json AS value FROM sessions WHERE session_id = ?", sessionId)
      .toArray()[0];
    return row ? (JSON.parse(row.value) as SessionRow) : null;
  }

  hasEvent(eventId: string): boolean {
    return (
      (this.sql
        .exec<CountRow>("SELECT COUNT(*) AS count FROM events WHERE event_id = ?", eventId)
        .toArray()[0]?.count ?? 0) > 0
    );
  }

  listEvents(sessionId: string, limit: number): StoredEvent[] {
    const rows = this.sql
      .exec<EventRow>(
        "SELECT board_seq, machine_id, received_at, envelope_json FROM events WHERE session_id = ? ORDER BY internal_id DESC LIMIT ?",
        sessionId,
        limit,
      )
      .toArray()
      .reverse();
    return rows.map((row) => ({
      board_seq: row.board_seq,
      envelope: parseEnvelope(JSON.parse(row.envelope_json)),
      machine_id: row.machine_id,
      received_at: row.received_at,
    }));
  }

  listMachines(): MachineRow[] {
    return this.sql
      .exec<KeyValueRow>("SELECT row_json AS value FROM machines ORDER BY machine_id")
      .toArray()
      .map((row) => JSON.parse(row.value) as MachineRow);
  }

  listSessions(machineId: string | undefined, limit: number, offset: number): SessionRow[] {
    const rows = machineId
      ? this.sql
          .exec<KeyValueRow>(
            "SELECT row_json AS value FROM sessions WHERE machine_id = ? ORDER BY last_event_at DESC LIMIT ? OFFSET ?",
            machineId,
            limit,
            offset,
          )
          .toArray()
      : this.sql
          .exec<KeyValueRow>(
            "SELECT row_json AS value FROM sessions ORDER BY last_event_at DESC LIMIT ? OFFSET ?",
            limit,
            offset,
          )
          .toArray();
    return rows.map((row) => JSON.parse(row.value) as SessionRow);
  }

  listSessionsSince(sequence: number): SessionRow[] {
    return this.sql
      .exec<KeyValueRow>(
        "SELECT row_json AS value FROM sessions WHERE board_seq > ? ORDER BY board_seq ASC",
        sequence,
      )
      .toArray()
      .map((row) => JSON.parse(row.value) as SessionRow);
  }

  nextSequence(): number {
    const next = this.sequence() + 1;
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES ('board_seq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      String(next),
    );
    return next;
  }

  prune(eventCutoff: string, endedCutoff: string): PruneCounts {
    const beforeEvents = this.countEvents();
    this.sql.exec("DELETE FROM events WHERE received_at < ?", eventCutoff);
    const events = beforeEvents - this.countEvents();
    const beforeSessions = this.countSessions();
    this.sql.exec(
      "DELETE FROM sessions WHERE lifecycle != 'active' AND last_event_at < ?",
      endedCutoff,
    );
    const terminal = TERMINAL_STATUSES.map(() => "?").join(", ");
    const stale = `SELECT message_id FROM messages WHERE status IN (${terminal}) AND updated_at < ?`;
    const messages =
      this.sql
        .exec<CountRow>(
          `SELECT COUNT(*) AS count FROM (${stale})`,
          ...TERMINAL_STATUSES,
          endedCutoff,
        )
        .toArray()[0]?.count ?? 0;
    this.sql.exec(
      `DELETE FROM audit WHERE message_id IN (${stale})`,
      ...TERMINAL_STATUSES,
      endedCutoff,
    );
    this.sql.exec(
      `DELETE FROM messages WHERE message_id IN (${stale})`,
      ...TERMINAL_STATUSES,
      endedCutoff,
    );
    return { events, messages, sessions: beforeSessions - this.countSessions() };
  }

  putMachine(machine: MachineRow): void {
    this.sql.exec(
      "INSERT INTO machines (machine_id, row_json) VALUES (?, ?) ON CONFLICT(machine_id) DO UPDATE SET row_json = excluded.row_json",
      machine.machine_id,
      JSON.stringify(machine),
    );
    this.metrics.heartbeatWrites += 1;
  }

  putSession(session: SessionRow): void {
    this.sql.exec(
      "INSERT INTO sessions (session_id, machine_id, lifecycle, last_event_at, board_seq, row_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET machine_id = excluded.machine_id, lifecycle = excluded.lifecycle, last_event_at = excluded.last_event_at, board_seq = excluded.board_seq, row_json = excluded.row_json",
      session.session_id,
      session.machine_id,
      session.lifecycle,
      session.last_event_at,
      session.board_seq,
      JSON.stringify(session),
    );
    this.metrics.sessionWrites += 1;
  }

  sequence(): number {
    const row = this.sql
      .exec<KeyValueRow>("SELECT value FROM meta WHERE key = 'board_seq'")
      .toArray()[0];
    return row ? Number(row.value) : 0;
  }
}

function semantic(row: SessionRow): string {
  const copy = { ...row, board_seq: 0, last_event_at: "" };
  return JSON.stringify(copy);
}

export interface IngestResult {
  accepted: number;
  changed: SessionRow[];
  duplicates: number;
}

export interface MessageOutcome {
  message: DialogueMessage;
  replyMessage: DialogueMessage | null;
}

const REASON_LIMIT = 200;
const RECLAIM_GRACE_MS = 60_000;

function plusMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

function validBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) throw new Error("message body is empty");
  if (trimmed.length > PERF.dialogueMessageMaxChars) throw new Error("message too long");
  return trimmed;
}

export class BoardService {
  private readonly backend: BoardBackend;

  constructor(backend: BoardBackend) {
    this.backend = backend;
  }

  ingest(
    machineId: string,
    envelopes: ReturnType<typeof parseEnvelope>[],
    receivedAt = new Date().toISOString(),
  ): IngestResult {
    this.backend.metrics.ingestRequests += 1;
    let accepted = 0;
    let duplicates = 0;
    const changed: SessionRow[] = [];
    const touched = new Set<string>();
    const originals = new Map<string, SessionRow | null>();
    const working = new Map<string, SessionRow>();
    const pendingEvents = new Map<string, StoredEvent[]>();
    const seenInBatch = new Set<string>();
    for (const envelope of envelopes) {
      if (seenInBatch.has(envelope.event_id) || this.backend.hasEvent(envelope.event_id)) {
        duplicates += 1;
        continue;
      }
      seenInBatch.add(envelope.event_id);
      accepted += 1;
      if (!originals.has(envelope.session_id)) {
        originals.set(envelope.session_id, this.backend.getSession(envelope.session_id));
      }
      const current =
        working.get(envelope.session_id) ?? originals.get(envelope.session_id) ?? null;
      const candidate = applyEvent(current, envelope, receivedAt, machineId);
      working.set(envelope.session_id, candidate);
      const events = pendingEvents.get(envelope.session_id) ?? [];
      events.push({
        board_seq: current?.board_seq ?? 0,
        envelope,
        machine_id: machineId,
        received_at: receivedAt,
      });
      pendingEvents.set(envelope.session_id, events);
      touched.add(envelope.session_id);
    }
    for (const sessionId of touched) {
      const original = originals.get(sessionId) ?? null;
      const candidate = working.get(sessionId);
      if (!candidate) continue;
      let eventSequence = original?.board_seq ?? 0;
      if (!original || semantic(candidate) !== semantic(original)) {
        const sequence = this.backend.nextSequence();
        candidate.board_seq = sequence;
        candidate.last_event_at = receivedAt;
        this.backend.putSession(candidate);
        changed.push(clone(candidate));
        eventSequence = sequence;
      } else if (
        Date.parse(receivedAt) - Date.parse(original.last_event_at) >=
        PERF.lastSeenWriteThrottleMs
      ) {
        this.backend.putSession({ ...original, last_event_at: receivedAt });
        eventSequence = original.board_seq;
      }
      for (const event of pendingEvents.get(sessionId) ?? []) {
        this.backend.addEvent({ ...event, board_seq: eventSequence });
      }
    }
    for (const sessionId of touched) {
      this.backend.deleteOldestEvents(PERF.eventsPerSessionCap, sessionId);
    }
    if (touched.size) this.backend.deleteOldestEvents(PERF.eventsGlobalCap);
    if (this.backend.countSessions() > PERF.sessionsGlobalCap) {
      this.backend.deleteOldestSessions(PERF.sessionsGlobalCap);
    }
    return { accepted, changed, duplicates };
  }

  heartbeat(
    machineId: string,
    senderVersion: string,
    spoolDepth: number,
    receivedAt = new Date().toISOString(),
  ): { commands: PendingCommand[]; throttled: boolean } {
    const commands = this.offerCommands(machineId, receivedAt);
    const current = this.backend.getMachine(machineId);
    if (
      current &&
      Date.parse(receivedAt) - Date.parse(current.last_heartbeat_at) < PERF.heartbeatWriteThrottleMs
    ) {
      return { commands, throttled: true };
    }
    this.backend.putMachine({
      last_heartbeat_at: receivedAt,
      machine_id: machineId,
      sender_version: senderVersion,
      spool_depth: spoolDepth,
    });
    return { commands, throttled: false };
  }

  private audit(
    messageId: string,
    actor: string,
    action: string,
    at: string,
    detail: string | null = null,
  ): void {
    this.backend.addAudit({ action, actor, at, detail, message_id: messageId });
  }

  private transition(
    message: DialogueMessage,
    status: DialogueStatus,
    actor: string,
    nowIso: string,
    changes: Partial<DialogueMessage> = {},
    detail: string | null = null,
    action: string = status,
  ): DialogueMessage {
    const next: DialogueMessage = { ...message, ...changes, status, updated_at: nowIso };
    this.backend.putMessage(next);
    this.audit(next.message_id, actor, action, nowIso, detail);
    return next;
  }

  private addReply(
    original: DialogueMessage,
    author: DialogueMessage["author"],
    body: string,
    nowIso: string,
  ): DialogueMessage {
    const reply: DialogueMessage = {
      author,
      body: truncate(body, MESSAGE_LIMIT),
      created_at: nowIso,
      expires_at: original.expires_at,
      machine_id: original.machine_id,
      message_id: newMessageId(),
      reason: null,
      reply_to: original.message_id,
      session_id: original.session_id,
      status: "answered",
      thread_id: original.thread_id,
      updated_at: nowIso,
    };
    this.backend.addMessage(reply);
    return reply;
  }

  private enforceThreadCap(threadId: string): void {
    const count = this.backend.countMessages(threadId);
    const excess = count - PERF.dialogueThreadCap;
    if (excess <= 0) return;
    const victims = this.backend
      .listMessages(threadId, count)
      .filter((message) => isTerminal(message.status))
      .slice(0, excess)
      .map((message) => message.message_id);
    if (victims.length) this.backend.deleteMessages(victims);
  }

  createMessage(
    threadId: string,
    body: string,
    nowIso = new Date().toISOString(),
  ): DialogueMessage {
    const text = validBody(body);
    let session: SessionRow | null = null;
    if (threadId !== MUSE_THREAD_ID) {
      session = this.backend.getSession(threadId);
      if (!session) throw new Error("session not found");
    }
    const message: DialogueMessage = {
      author: "pen",
      body: text,
      created_at: nowIso,
      expires_at: plusMs(nowIso, PERF.dialogueExpiryMs),
      machine_id: session?.machine_id ?? null,
      message_id: newMessageId(),
      reason: null,
      reply_to: null,
      session_id: session?.session_id ?? null,
      status: "queued",
      thread_id: threadId,
      updated_at: nowIso,
    };
    this.backend.addMessage(message);
    this.audit(message.message_id, "pen", "created", nowIso);
    this.enforceThreadCap(threadId);
    return message;
  }

  listThread(threadId: string, limit: number): DialogueMessage[] {
    return this.backend.listMessages(
      threadId,
      Math.max(1, Math.min(PERF.dialogueThreadCap, Math.floor(limit))),
    );
  }

  expireMessages(machineId: string | null, nowIso = new Date().toISOString()): DialogueMessage[] {
    const now = Date.parse(nowIso);
    return this.backend
      .listMessagesByStatus(machineId, ["queued", "held_busy"])
      .filter((message) => Date.parse(message.expires_at) <= now)
      .map((message) => this.transition(message, "expired", "worker", nowIso));
  }

  offerCommands(machineId: string, nowIso = new Date().toISOString()): PendingCommand[] {
    this.expireMessages(machineId, nowIso);
    const now = Date.parse(nowIso);
    const reclaimBefore = now - (PERF.dialogueExecTimeoutMs + RECLAIM_GRACE_MS);
    // A session is blocked once it has a command in flight or its oldest waiting
    // message is not yet eligible, so each session receives its messages in order.
    const blocked = new Set<string>();
    for (const message of this.backend.listMessagesByStatus(machineId, ["delivered", "running"])) {
      if (Date.parse(message.updated_at) < reclaimBefore) {
        this.transition(message, "queued", "worker", nowIso, {}, null, "reclaimed");
      } else if (message.session_id) {
        blocked.add(message.session_id);
      }
    }
    const commands: PendingCommand[] = [];
    for (const message of this.backend.listMessagesByStatus(machineId, ["queued", "held_busy"])) {
      const sessionId = message.session_id;
      if (!sessionId || blocked.has(sessionId)) continue;
      if (Date.parse(message.expires_at) <= now) continue;
      const session = this.backend.getSession(sessionId);
      if (!session) {
        this.transition(
          message,
          "failed",
          "worker",
          nowIso,
          { reason: "session_not_found" },
          "session_not_found",
        );
        continue;
      }
      blocked.add(sessionId);
      if (message.status === "held_busy") {
        const sessionMoved = session.board_seq > (message.last_offer_seq ?? -1);
        const retryDue = now - Date.parse(message.updated_at) >= PERF.dialogueHeldRetryMs;
        if (!sessionMoved && !retryDue) continue;
      }
      this.transition(message, "delivered", machineId, nowIso, { reason: null }, null, "offered");
      commands.push({
        body: message.body,
        cli: session.cli,
        cwd: session.cwd,
        message_id: message.message_id,
        session_id: sessionId,
      });
    }
    return commands;
  }

  reportResult(
    machineId: string,
    messageId: string,
    result: CommandResult,
    nowIso = new Date().toISOString(),
  ): MessageOutcome {
    const message = this.backend.getMessage(messageId);
    if (!message) throw new Error("message not found");
    if (message.machine_id !== machineId) throw new Error("message belongs to another machine");
    const inFlight = message.status === "delivered" || message.status === "running";
    if (result.status === "running" && message.status === "delivered") {
      return {
        message: this.transition(message, "running", machineId, nowIso),
        replyMessage: null,
      };
    }
    if (result.status === "answered" && inFlight) {
      const answered = this.transition(message, "answered", machineId, nowIso, { reason: null });
      const replyMessage = this.addReply(message, "agent", result.reply ?? "", nowIso);
      this.enforceThreadCap(message.thread_id);
      return { message: answered, replyMessage };
    }
    if (result.status === "held_busy" && inFlight) {
      const reason = truncate(result.reason ?? "busy", REASON_LIMIT);
      const session = message.session_id ? this.backend.getSession(message.session_id) : null;
      const held = this.transition(
        message,
        "held_busy",
        machineId,
        nowIso,
        { last_offer_seq: session?.board_seq ?? null, reason },
        reason,
      );
      return { message: held, replyMessage: null };
    }
    if (result.status === "failed" && inFlight) {
      const reason = truncate(result.reason ?? "failed", REASON_LIMIT);
      const failed = this.transition(message, "failed", machineId, nowIso, { reason }, reason);
      return { message: failed, replyMessage: null };
    }
    throw new Error("invalid transition");
  }

  museInbox(nowIso = new Date().toISOString()): DialogueMessage[] {
    this.expireMessages(null, nowIso);
    return this.backend
      .listMessagesByStatus(null, ["queued"])
      .filter((message) => message.thread_id === MUSE_THREAD_ID && message.author === "pen");
  }

  museReply(messageId: string, body: string, nowIso = new Date().toISOString()): MessageOutcome {
    const text = validBody(body);
    this.expireMessages(null, nowIso);
    const original = this.backend.getMessage(messageId);
    if (!original || original.thread_id !== MUSE_THREAD_ID) throw new Error("message not found");
    if (original.author !== "pen" || original.status !== "queued") {
      throw new Error("invalid transition");
    }
    const replyMessage = this.addReply(original, "muse", text, nowIso);
    this.audit(replyMessage.message_id, "muse", "replied", nowIso);
    const message = this.transition(original, "answered", "muse", nowIso);
    this.enforceThreadCap(MUSE_THREAD_ID);
    return { message, replyMessage };
  }

  getSession(sessionId: string): SessionRow | null {
    return this.backend.getSession(sessionId);
  }

  listSessions(machineId: string | undefined, limit: number, offset: number): SessionRow[] {
    return this.backend.listSessions(machineId, limit, offset);
  }

  listMachines(): MachineRow[] {
    return this.backend.listMachines();
  }

  recentEvents(sessionId: string, limit: number): StoredEvent[] {
    return this.backend.listEvents(sessionId, limit);
  }

  resync(since: number): { machines: MachineRow[]; sequence: number; sessions: SessionRow[] } {
    return {
      machines: this.backend.listMachines(),
      sequence: this.backend.sequence(),
      sessions: this.backend.listSessionsSince(since),
    };
  }

  prune(
    now = new Date(),
    eventRetentionDays: number = PERF.eventRetentionDays,
    sessionRetentionDays: number = PERF.sessionRetentionDays,
  ): PruneCounts {
    const eventCutoff = new Date(
      now.getTime() - eventRetentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    const endedCutoff = new Date(
      now.getTime() - sessionRetentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    return this.backend.prune(eventCutoff, endedCutoff);
  }

  metrics(): StoreMetrics & {
    events: number;
    normalizer_version: number;
    sequence: number;
    sessions: number;
  } {
    return {
      ...this.backend.metrics,
      events: this.backend.countEvents(),
      normalizer_version: NORMALIZER_VERSION,
      sequence: this.backend.sequence(),
      sessions: this.backend.countSessions(),
    };
  }

  seedSession(row: SessionRow): void {
    this.backend.putSession(row);
  }

  seedMachine(row: MachineRow): void {
    this.backend.putMachine(row);
  }
}
