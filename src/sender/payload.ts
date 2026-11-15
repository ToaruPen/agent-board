import type { CliKind, EventEnvelope } from "../shared/envelope.js";
import { newEventId } from "../shared/ids.js";

export const SENDER_VERSION = "0.1.0";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function detectCli(raw: Record<string, unknown>): CliKind {
  if (raw.cli === "codex" || typeof raw["thread-id"] === "string") return "codex";
  if (typeof raw.transcript_path === "string" && raw.transcript_path.includes("codex")) {
    return "codex";
  }
  return "claude-code";
}

export function payloadToEnvelope(
  rawValue: unknown,
  cliVersion = "unknown",
  makeId: () => string = newEventId,
  cliOverride?: CliKind,
): EventEnvelope {
  if (!isRecord(rawValue)) throw new Error("hook payload must be an object");
  const sessionId =
    str(rawValue.session_id) ?? str(rawValue["thread-id"]) ?? str(rawValue.thread_id);
  const eventName = str(rawValue.hook_event_name) ?? str(rawValue.event_name) ?? str(rawValue.type);
  if (!sessionId || !eventName) throw new Error("hook payload is missing session or event name");
  const toolInput = isRecord(rawValue.tool_input) ? rawValue.tool_input : undefined;
  const envelope: EventEnvelope = {
    cli: cliOverride ?? detectCli(rawValue),
    cli_version: cliVersion,
    event_id: makeId(),
    event_name: eventName,
    occurred_at: new Date().toISOString(),
    sender_version: SENDER_VERSION,
    session_id: sessionId,
    v: 1,
  };
  const optional: Array<[keyof EventEnvelope, unknown]> = [
    ["agent_id", rawValue.agent_id],
    ["agent_type", rawValue.agent_type ?? toolInput?.subagent_type],
    ["cwd", rawValue.cwd],
    ["last_assistant_message", rawValue.last_assistant_message],
    ["notification_type", rawValue.notification_type ?? rawValue.message],
    ["prompt", rawValue.prompt],
    ["tool_name", rawValue.tool_name],
  ];
  for (const [key, raw] of optional) {
    const parsed = str(raw);
    if (parsed !== undefined) Object.assign(envelope, { [key]: parsed });
  }
  return envelope;
}
