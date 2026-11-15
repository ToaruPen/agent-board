export type CliKind = "claude-code" | "codex";

export type Lifecycle = "active" | "ended" | "failed";
export type Activity = "running" | "idle" | "unknown";
export type Attention = "none" | "needs_approval" | "needs_input" | "elicitation";

export interface AttentionEvidence {
  at: string;
  event_name: string;
}

export interface SubagentInfo {
  agent_id: string;
  agent_type: string;
  status: "running" | "stopped";
}

export interface EventEnvelope {
  agent_id?: string;
  agent_type?: string;
  cli: CliKind;
  cli_version: string;
  cwd?: string;
  event_id: string;
  event_name: string;
  last_assistant_message?: string;
  notification_type?: string;
  occurred_at: string;
  dropped_tool_events?: number;
  prompt?: string;
  pulse_count?: number;
  sender_version: string;
  session_id: string;
  tool_name?: string;
  v: 1;
}

export interface SessionRow {
  activity: Activity;
  attention: Attention;
  attention_evidence: AttentionEvidence | null;
  board_seq: number;
  cli: CliKind;
  cwd: string;
  dropped_tool_events: number;
  last_event_at: string;
  last_message: string;
  last_prompt: string;
  last_tool: string | null;
  lifecycle: Lifecycle;
  machine_id: string;
  session_id: string;
  subagent_count: number;
  subagents: SubagentInfo[];
  title: string;
  tool_pulses: number;
}

export interface StoredEvent {
  board_seq: number;
  envelope: EventEnvelope;
  machine_id: string;
  received_at: string;
}

export interface MachineRow {
  last_heartbeat_at: string;
  machine_id: string;
  sender_version: string;
  spool_depth: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parseEnvelope(value: unknown): EventEnvelope {
  if (!isRecord(value)) throw new Error("envelope must be an object");
  if (value.v !== 1) throw new Error("envelope v must be 1");
  const cli = value.cli;
  if (cli !== "claude-code" && cli !== "codex") throw new Error("envelope cli is invalid");
  const eventId = str(value.event_id);
  const sessionId = str(value.session_id);
  const eventName = str(value.event_name);
  const occurredAt = str(value.occurred_at);
  if (!eventId || !sessionId || !eventName || !occurredAt) {
    throw new Error("envelope is missing a required field");
  }
  const envelope: EventEnvelope = {
    cli,
    cli_version: str(value.cli_version) ?? "unknown",
    event_id: eventId,
    event_name: eventName,
    occurred_at: occurredAt,
    sender_version: str(value.sender_version) ?? "unknown",
    session_id: sessionId,
    v: 1,
  };
  if (value.pulse_count !== undefined) {
    if (
      typeof value.pulse_count !== "number" ||
      !Number.isInteger(value.pulse_count) ||
      value.pulse_count < 1 ||
      value.pulse_count > 10_000
    ) {
      throw new Error("envelope pulse_count is invalid");
    }
    envelope.pulse_count = value.pulse_count;
  }
  if (value.dropped_tool_events !== undefined) {
    if (
      typeof value.dropped_tool_events !== "number" ||
      !Number.isInteger(value.dropped_tool_events) ||
      value.dropped_tool_events < 0 ||
      value.dropped_tool_events > 1_000_000
    ) {
      throw new Error("envelope dropped_tool_events is invalid");
    }
    envelope.dropped_tool_events = value.dropped_tool_events;
  }
  const optional: Array<[keyof EventEnvelope, unknown]> = [
    ["agent_id", value.agent_id],
    ["agent_type", value.agent_type],
    ["cwd", value.cwd],
    ["last_assistant_message", value.last_assistant_message],
    ["notification_type", value.notification_type],
    ["prompt", value.prompt],
    ["tool_name", value.tool_name],
  ];
  for (const [key, raw] of optional) {
    const parsed = str(raw);
    if (parsed !== undefined) {
      Object.assign(envelope, { [key]: parsed });
    }
  }
  return envelope;
}
