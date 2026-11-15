import type { EventEnvelope, SessionRow, SubagentInfo } from "./envelope.js";
import { MESSAGE_LIMIT, PROMPT_LIMIT, TITLE_LIMIT, truncate } from "./limits.js";

export const NORMALIZER_VERSION = 1;

const STATE_CHANGING = new Set([
  "Notification",
  "PermissionDenied",
  "PermissionRequest",
  "SessionEnd",
  "SessionStart",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "UserPromptSubmit",
]);

export function isStateChanging(eventName: string): boolean {
  return STATE_CHANGING.has(eventName);
}

function blank(machineId: string, envelope: EventEnvelope, receivedAt: string): SessionRow {
  return {
    activity: "unknown",
    attention: "none",
    attention_evidence: null,
    board_seq: 0,
    cli: envelope.cli,
    cwd: envelope.cwd ?? "",
    dropped_tool_events: 0,
    last_event_at: receivedAt,
    last_message: "",
    last_prompt: "",
    last_tool: null,
    lifecycle: "active",
    machine_id: machineId,
    session_id: envelope.session_id,
    subagent_count: 0,
    subagents: [],
    title: "",
    tool_pulses: 0,
  };
}

function attentionForNotification(envelope: EventEnvelope): SessionRow["attention"] {
  const kind = (envelope.notification_type ?? "").toLowerCase();
  if (kind.includes("permission")) return "needs_approval";
  if (kind.includes("elicitation")) return "elicitation";
  if (kind.includes("needs_input") || kind.includes("input")) return "needs_input";
  return "none";
}

export function applyEvent(
  prev: SessionRow | null,
  envelope: EventEnvelope,
  receivedAt: string,
  machineId: string,
): SessionRow {
  const row: SessionRow = prev
    ? { ...prev, subagents: [...prev.subagents] }
    : blank(machineId, envelope, receivedAt);
  row.machine_id = machineId;
  row.cli = envelope.cli;
  row.last_event_at = receivedAt;
  if (envelope.dropped_tool_events) row.dropped_tool_events += envelope.dropped_tool_events;
  if (envelope.cwd) row.cwd = envelope.cwd;
  if (envelope.last_assistant_message) {
    row.last_message = truncate(envelope.last_assistant_message, MESSAGE_LIMIT);
  }
  if (envelope.prompt) {
    row.last_prompt = truncate(envelope.prompt, PROMPT_LIMIT);
    if (!row.title) row.title = truncate(envelope.prompt, TITLE_LIMIT);
  }

  switch (envelope.event_name) {
    case "SessionStart":
      row.lifecycle = "active";
      row.activity = "idle";
      break;
    case "UserPromptSubmit":
      row.lifecycle = "active";
      row.activity = "running";
      row.attention = "none";
      row.attention_evidence = null;
      break;
    case "PreToolUse":
      row.activity = "running";
      row.last_tool = envelope.tool_name ?? row.last_tool;
      row.tool_pulses += envelope.pulse_count ?? 1;
      break;
    case "PostToolUse":
      row.activity = "running";
      row.last_tool = envelope.tool_name ?? row.last_tool;
      row.tool_pulses += envelope.pulse_count ?? 1;
      row.attention = "none";
      row.attention_evidence = null;
      break;
    case "PermissionRequest":
      row.attention = "needs_approval";
      row.attention_evidence = { at: receivedAt, event_name: envelope.event_name };
      break;
    case "PermissionDenied":
      row.attention = "needs_approval";
      row.attention_evidence = { at: receivedAt, event_name: envelope.event_name };
      break;
    case "Notification": {
      const attention = attentionForNotification(envelope);
      if (attention !== "none") {
        row.attention = attention;
        row.attention_evidence = { at: receivedAt, event_name: envelope.event_name };
      }
      break;
    }
    case "Stop":
      row.activity = "idle";
      row.attention = "none";
      row.attention_evidence = null;
      break;
    case "StopFailure":
      row.lifecycle = "failed";
      row.activity = "idle";
      row.attention = "none";
      row.attention_evidence = null;
      break;
    case "SessionEnd":
      row.lifecycle = "ended";
      row.activity = "idle";
      row.attention = "none";
      row.attention_evidence = null;
      break;
    case "SubagentStart": {
      const agentId = envelope.agent_id ?? `sub-${envelope.session_id}-${row.subagents.length + 1}`;
      const info: SubagentInfo = {
        agent_id: agentId,
        agent_type: envelope.agent_type ?? "unknown",
        status: "running",
      };
      row.subagents = [...row.subagents.filter((s) => s.agent_id !== agentId), info];
      break;
    }
    case "SubagentStop": {
      const agentId = envelope.agent_id;
      let stoppedOne = false;
      row.subagents = row.subagents.map((s) => {
        if (s.status !== "running") return s;
        if (agentId) return s.agent_id === agentId ? { ...s, status: "stopped" } : s;
        if (stoppedOne) return s;
        stoppedOne = true;
        return { ...s, status: "stopped" };
      });
      if (envelope.last_assistant_message) {
        row.last_message = truncate(envelope.last_assistant_message, MESSAGE_LIMIT);
      }
      break;
    }
    default:
      break;
  }
  row.subagent_count = row.subagents.filter((s) => s.status === "running").length;
  return row;
}
