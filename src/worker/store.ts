import type { MachineRow, SessionRow, StoredEvent } from "../shared/envelope.js";
import { parseEnvelope } from "../shared/envelope.js";
import { applyEvent, NORMALIZER_VERSION } from "../shared/normalizer.js";
import { PERF } from "../shared/perf.js";

export const WORKER_PERF = PERF;

export interface StoreMetrics {
  broadcasts: number;
  eventWrites: number;
  heartbeatWrites: number;
  sessionWrites: number;
}

export interface BoardBackend {
  readonly metrics: StoreMetrics;
  addEvent(event: StoredEvent): void;
  countEvents(): number;
  countSessions(): number;
  deleteOldestEvents(keep: number, sessionId?: string): number;
  deleteOldestSessions(keep: number): number;
  getMachine(machineId: string): MachineRow | null;
  getSession(sessionId: string): SessionRow | null;
  hasEvent(eventId: string): boolean;
  listEvents(sessionId: string, limit: number): StoredEvent[];
  listMachines(): MachineRow[];
  listSessions(machineId: string | undefined, limit: number, offset: number): SessionRow[];
  listSessionsSince(sequence: number): SessionRow[];
  nextSequence(): number;
  prune(eventCutoff: string, endedCutoff: string): { events: number; sessions: number };
  putMachine(machine: MachineRow): void;
  putSession(session: SessionRow): void;
  sequence(): number;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class MemoryBoardBackend implements BoardBackend {
  readonly metrics: StoreMetrics = {
    broadcasts: 0,
    eventWrites: 0,
    heartbeatWrites: 0,
    sessionWrites: 0,
  };
  private currentSequence = 0;
  private readonly events: StoredEvent[] = [];
  private readonly machines = new Map<string, MachineRow>();
  private readonly sessions = new Map<string, SessionRow>();

  addEvent(event: StoredEvent): void {
    this.events.push(clone(event));
    this.metrics.eventWrites += 1;
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

  prune(eventCutoff: string, endedCutoff: string): { events: number; sessions: number } {
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
    return { events: beforeEvents - keptEvents.length, sessions };
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
  one(): T | null;
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

export class SqlBoardBackend implements BoardBackend {
  readonly metrics: StoreMetrics = {
    broadcasts: 0,
    eventWrites: 0,
    heartbeatWrites: 0,
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
    return this.sql.exec<CountRow>("SELECT COUNT(*) AS count FROM events").one()?.count ?? 0;
  }

  countSessions(): number {
    return this.sql.exec<CountRow>("SELECT COUNT(*) AS count FROM sessions").one()?.count ?? 0;
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
      .one();
    return row ? (JSON.parse(row.value) as MachineRow) : null;
  }

  getSession(sessionId: string): SessionRow | null {
    const row = this.sql
      .exec<KeyValueRow>("SELECT row_json AS value FROM sessions WHERE session_id = ?", sessionId)
      .one();
    return row ? (JSON.parse(row.value) as SessionRow) : null;
  }

  hasEvent(eventId: string): boolean {
    return (
      (this.sql
        .exec<CountRow>("SELECT COUNT(*) AS count FROM events WHERE event_id = ?", eventId)
        .one()?.count ?? 0) > 0
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

  prune(eventCutoff: string, endedCutoff: string): { events: number; sessions: number } {
    const beforeEvents = this.countEvents();
    this.sql.exec("DELETE FROM events WHERE received_at < ?", eventCutoff);
    const events = beforeEvents - this.countEvents();
    const beforeSessions = this.countSessions();
    this.sql.exec(
      "DELETE FROM sessions WHERE lifecycle != 'active' AND last_event_at < ?",
      endedCutoff,
    );
    return { events, sessions: beforeSessions - this.countSessions() };
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
    const row = this.sql.exec<KeyValueRow>("SELECT value FROM meta WHERE key = 'board_seq'").one();
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
  ): { throttled: boolean } {
    const current = this.backend.getMachine(machineId);
    if (
      current &&
      Date.parse(receivedAt) - Date.parse(current.last_heartbeat_at) < PERF.heartbeatWriteThrottleMs
    ) {
      return { throttled: true };
    }
    this.backend.putMachine({
      last_heartbeat_at: receivedAt,
      machine_id: machineId,
      sender_version: senderVersion,
      spool_depth: spoolDepth,
    });
    return { throttled: false };
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
  ): { events: number; sessions: number } {
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
