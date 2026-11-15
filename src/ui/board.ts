import type { MachineRow, SessionRow } from "../shared/envelope.js";

interface SnapshotMessage {
  machines: MachineRow[];
  sequence: number;
  sessions: SessionRow[];
  type: "snapshot";
}

interface SessionMessage {
  session: SessionRow;
  sequence: number;
  type: "session";
}

const sessions = new Map<string, SessionRow>();
const machines = new Map<string, MachineRow>();
let lastSequence = 0;
let resyncing = false;

const board = document.querySelector<HTMLElement>("#board");
const machineList = document.querySelector<HTMLElement>("#machines");
const status = document.querySelector<HTMLElement>("#status");

function element(tag: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderMachines(): void {
  if (!machineList) return;
  machineList.replaceChildren();
  const now = Date.now();
  for (const machine of machines.values()) {
    const age = Math.max(0, Math.floor((now - Date.parse(machine.last_heartbeat_at)) / 1000));
    const item = element(
      "li",
      `${machine.machine_id}: ${age <= 120 ? "online" : "offline"}, heartbeat ${age}s ago, spool ${machine.spool_depth}, sender ${machine.sender_version}`,
    );
    item.dataset.state = age <= 120 ? "online" : "offline";
    machineList.append(item);
  }
}

function renderSessions(): void {
  if (!board) return;
  board.replaceChildren();
  const rows = [...sessions.values()].sort((a, b) =>
    b.last_event_at.localeCompare(a.last_event_at),
  );
  for (const session of rows) {
    const card = element("article");
    card.className = "card";
    const heading = element("h2", session.title || session.session_id);
    const meta = element(
      "p",
      `${session.machine_id} | ${session.cli} | ${session.lifecycle} | ${session.activity}`,
    );
    const attention = element(
      "p",
      session.attention === "none"
        ? "Attention: none"
        : `Attention: ${session.attention} from ${session.attention_evidence?.event_name ?? "unknown"}`,
    );
    attention.className = session.attention === "none" ? "ok" : "attention";
    const detail = element(
      "p",
      `Last tool: ${session.last_tool ?? "none"} | pulses: ${session.tool_pulses} | cwd: ${session.cwd}`,
    );
    const seconds = element("p");
    seconds.dataset.secondsFor = session.session_id;
    seconds.dataset.lastEventAt = session.last_event_at;
    const prompt = element("p", session.last_prompt || session.last_message);
    const drill = document.createElement("details");
    const summary = element("summary", `Subagents: ${session.subagent_count} running`);
    drill.append(summary);
    if (!session.subagents.length) drill.append(element("p", "No subagents recorded."));
    for (const subagent of session.subagents) {
      drill.append(
        element("p", `${subagent.agent_id} | ${subagent.agent_type} | ${subagent.status}`),
      );
    }
    card.append(heading, meta, attention, detail, seconds, prompt, drill);
    board.append(card);
  }
  updateSeconds();
}

function updateSeconds(): void {
  const now = Date.now();
  for (const node of document.querySelectorAll<HTMLElement>("[data-seconds-for]")) {
    const at = Date.parse(node.dataset.lastEventAt ?? "");
    const seconds = Number.isFinite(at) ? Math.max(0, Math.floor((now - at) / 1000)) : 0;
    node.textContent = `Last event: ${seconds}s ago`;
  }
}

function render(): void {
  renderMachines();
  renderSessions();
}

async function resync(): Promise<void> {
  if (resyncing) return;
  resyncing = true;
  try {
    const response = await fetch(`/api/resync?since=${lastSequence}`);
    if (!response.ok) return;
    const data = (await response.json()) as {
      machines: MachineRow[];
      sequence: number;
      sessions: SessionRow[];
    };
    for (const machine of data.machines) machines.set(machine.machine_id, machine);
    for (const session of data.sessions) sessions.set(session.session_id, session);
    lastSequence = Math.max(lastSequence, data.sequence);
    render();
  } finally {
    resyncing = false;
  }
}

async function load(): Promise<void> {
  const demo = new URLSearchParams(location.search).get("demo") === "1" ? "?demo=1" : "";
  const [sessionResponse, machineResponse] = await Promise.all([
    fetch(`/api/sessions${demo}`),
    fetch(`/api/machines${demo}`),
  ]);
  if (sessionResponse.ok) {
    const data = (await sessionResponse.json()) as { sessions: SessionRow[] };
    for (const session of data.sessions) {
      sessions.set(session.session_id, session);
      lastSequence = Math.max(lastSequence, session.board_seq);
    }
  }
  if (machineResponse.ok) {
    const data = (await machineResponse.json()) as { machines: MachineRow[] };
    for (const machine of data.machines) machines.set(machine.machine_id, machine);
  }
  render();
}

function connect(): void {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/api/stream`);
  socket.addEventListener("open", () => {
    if (status) status.textContent = "Live";
  });
  socket.addEventListener("message", (event) => {
    try {
      const data = JSON.parse(String(event.data)) as SnapshotMessage | SessionMessage;
      if (data.type === "snapshot") {
        for (const machine of data.machines) machines.set(machine.machine_id, machine);
        for (const session of data.sessions) sessions.set(session.session_id, session);
        lastSequence = data.sequence;
        render();
        return;
      }
      if (data.sequence > lastSequence + 1) {
        sessions.set(data.session.session_id, data.session);
        lastSequence = data.sequence;
        render();
        void resync();
        return;
      }
      sessions.set(data.session.session_id, data.session);
      lastSequence = Math.max(lastSequence, data.sequence);
      render();
    } catch {
      if (status) status.textContent = "Received an unreadable update";
    }
  });
  socket.addEventListener("close", () => {
    if (status) status.textContent = "Disconnected. Reload to reconnect.";
  });
}

void load().then(connect);
setInterval(updateSeconds, 1000);
