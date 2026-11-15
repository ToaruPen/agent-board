import {
  type DialogueAuthor,
  type DialogueMessage,
  type DialogueStatus,
  MUSE_THREAD_ID,
} from "../shared/dialogue.js";
import type { MachineRow, SessionRow } from "../shared/envelope.js";
import { PERF } from "../shared/perf.js";

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

interface ThreadMessage {
  thread_id: string;
  type: "thread";
}

const STATUS_LABELS: Record<DialogueStatus, string> = {
  answered: "回答済み",
  delivered: "配送済み",
  expired: "期限切れ",
  failed: "失敗",
  held_busy: "保留（実行中）",
  queued: "送信待ち",
  running: "実行中",
};

const AUTHOR_LABELS: Record<DialogueAuthor, string> = {
  agent: "エージェント",
  muse: "Muse",
  pen: "あなた",
};

const sessions = new Map<string, SessionRow>();
const machines = new Map<string, MachineRow>();
let lastSequence = 0;
let resyncing = false;

const board = document.querySelector<HTMLElement>("#board");
const machineList = document.querySelector<HTMLElement>("#machines");
const status = document.querySelector<HTMLElement>("#status");
const museThread = document.querySelector<HTMLElement>("#muse-thread");
// Thread containers by thread id. Session dialogue nodes survive card re-renders,
// so an open thread and a half typed message are not lost on a live update.
const threadViews = new Map<string, HTMLElement>();
const dialogues = new Map<string, HTMLDetailsElement>();

function element(tag: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function threadPath(threadId: string): string {
  return threadId === MUSE_THREAD_ID
    ? "/api/muse/messages"
    : `/api/sessions/${encodeURIComponent(threadId)}/messages`;
}

function renderMessage(message: DialogueMessage): HTMLElement {
  const item = element("li");
  item.className = "message";
  item.dataset.author = message.author;
  const header = element("p");
  header.append(element("strong", AUTHOR_LABELS[message.author]));
  if (message.author === "pen") {
    const chip = element("span", STATUS_LABELS[message.status]);
    chip.className = "chip";
    chip.dataset.status = message.status;
    header.append(" ", chip);
    if (message.reason) header.append(` (${message.reason})`);
  }
  item.append(header, element("p", message.body));
  return item;
}

function composer(threadId: string): HTMLFormElement {
  const form = document.createElement("form");
  const input = document.createElement("textarea");
  input.maxLength = PERF.dialogueMessageMaxChars;
  input.rows = 3;
  input.setAttribute("aria-label", "メッセージ");
  const button = document.createElement("button");
  button.type = "submit";
  button.textContent = "送信";
  const error = element("p");
  error.className = "attention";
  form.append(input, button, error);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const body = input.value.trim();
    if (!body || button.disabled) return;
    button.disabled = true;
    error.textContent = "";
    void fetch(threadPath(threadId), {
      body: JSON.stringify({ body }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
      .then(async (response) => {
        if (response.ok) input.value = "";
        else error.textContent = `送信に失敗しました（${response.status}）`;
        await loadThread(threadId);
      })
      .catch(() => {
        error.textContent = "送信に失敗しました";
      })
      .finally(() => {
        button.disabled = false;
      });
  });
  return form;
}

function renderThread(container: HTMLElement, threadId: string, messages: DialogueMessage[]): void {
  let list = container.querySelector<HTMLElement>(":scope > .thread");
  if (!list) {
    list = element("ol");
    list.className = "thread";
    container.replaceChildren(list, composer(threadId));
  }
  list.replaceChildren(...messages.map(renderMessage));
  if (!messages.length) list.append(element("li", "まだメッセージはありません。"));
}

async function loadThread(threadId: string): Promise<void> {
  const container = threadViews.get(threadId);
  if (!container) return;
  const response = await fetch(threadPath(threadId));
  if (!response.ok) return;
  const data = (await response.json()) as { messages: DialogueMessage[] };
  renderThread(container, threadId, data.messages);
}

function dialogueFor(sessionId: string): HTMLDetailsElement {
  const existing = dialogues.get(sessionId);
  if (existing) return existing;
  const details = document.createElement("details");
  details.className = "dialogue";
  const container = element("div");
  details.append(element("summary", "対話"), container);
  threadViews.set(sessionId, container);
  let loaded = false;
  details.addEventListener("toggle", () => {
    if (!details.open || loaded) return;
    loaded = true;
    void loadThread(sessionId);
  });
  dialogues.set(sessionId, details);
  return details;
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
    card.append(
      heading,
      meta,
      attention,
      detail,
      seconds,
      prompt,
      drill,
      dialogueFor(session.session_id),
    );
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
      const data = JSON.parse(String(event.data)) as
        | SnapshotMessage
        | SessionMessage
        | ThreadMessage;
      if (data.type === "thread") {
        if (data.thread_id === MUSE_THREAD_ID || dialogues.get(data.thread_id)?.open) {
          void loadThread(data.thread_id);
        }
        return;
      }
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

if (museThread) {
  threadViews.set(MUSE_THREAD_ID, museThread);
  void loadThread(MUSE_THREAD_ID);
}
void load().then(connect);
setInterval(updateSeconds, 1000);
