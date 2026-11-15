import type { MachineRow, SessionRow } from "../shared/envelope.js";

export const DEMO_MACHINES: MachineRow[] = [
  {
    last_heartbeat_at: "2026-01-01T00:00:00.000Z",
    machine_id: "machine-a",
    sender_version: "0.1.0",
    spool_depth: 0,
  },
  {
    last_heartbeat_at: "2026-01-01T00:00:00.000Z",
    machine_id: "machine-b",
    sender_version: "0.1.0",
    spool_depth: 2,
  },
];

export const DEMO_SESSIONS: SessionRow[] = [
  {
    activity: "running",
    attention: "none",
    attention_evidence: null,
    board_seq: 1,
    cli: "claude-code",
    cwd: "/example/demo-repo",
    dropped_tool_events: 0,
    last_event_at: "2026-01-01T00:00:00.000Z",
    last_message: "",
    last_prompt: "Fix the demo parser",
    last_tool: "Bash",
    lifecycle: "active",
    machine_id: "machine-a",
    session_id: "demo-session-1",
    subagent_count: 1,
    subagents: [{ agent_id: "demo-agent-1", agent_type: "reviewer", status: "running" }],
    title: "Fix the demo parser",
    tool_pulses: 4,
  },
  {
    activity: "idle",
    attention: "needs_input",
    attention_evidence: { at: "2026-01-01T00:00:00.000Z", event_name: "Notification" },
    board_seq: 2,
    cli: "codex",
    cwd: "/example/demo-docs",
    dropped_tool_events: 0,
    last_event_at: "2026-01-01T00:00:00.000Z",
    last_message: "",
    last_prompt: "Document the demo API",
    last_tool: null,
    lifecycle: "active",
    machine_id: "machine-b",
    session_id: "demo-session-2",
    subagent_count: 0,
    subagents: [],
    title: "Document the demo API",
    tool_pulses: 0,
  },
];
