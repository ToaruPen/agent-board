import {
  type DialogueAuthor,
  type DialogueMessage,
  type DialogueStatus,
  MUSE_THREAD_ID,
} from "../shared/dialogue.js";
import type {
  Activity,
  Attention,
  CliKind,
  Lifecycle,
  MachineRow,
  SessionRow,
  StoredEvent,
} from "../shared/envelope.js";
import { MESSAGE_LIMIT, PROMPT_LIMIT, TITLE_LIMIT } from "../shared/limits.js";
import { PERF } from "../shared/perf.js";

// ---------- data shapes ----------

type WaitKind = Exclude<Attention, "none">;
type Kind = "running" | "quiet" | "idle" | "unknown" | WaitKind | "ended" | "failed" | "failed-old";

interface View {
  ageAt: string;
  ageStrong: boolean;
  att: boolean;
  dim: boolean;
  kind: Kind;
  lab: string;
  label: string;
  mk: string;
  unconf: boolean;
}

type Selection = { kind: "overview" } | { kind: "session"; id: string } | { kind: "muse" };
type Conn = "connecting" | "live" | "lost";
type MachineState = "fresh" | "backlog" | "silent";

interface Project {
  active: string[];
  ended: string[];
  // Whether the project had an active session when it was placed. New projects go after these.
  hadActive: boolean;
  key: string;
  label: string;
  name: string;
}

interface Row {
  age: HTMLSpanElement;
  btn: HTMLButtonElement;
  lab: HTMLSpanElement;
  li: HTMLLIElement;
  meta: HTMLSpanElement;
  mk: HTMLSpanElement;
  sig: string;
  t: HTMLSpanElement;
  where: "tree" | "wait";
}

interface ProjectEls {
  btn: HTMLButtonElement;
  endBtn: HTMLButtonElement;
  endKids: HTMLUListElement;
  endLi: HTMLLIElement;
  endN: HTMLSpanElement;
  endTags: HTMLSpanElement;
  kids: HTMLUListElement;
  li: HTMLLIElement;
  n: HTMLSpanElement;
  sig: string;
  tags: HTMLSpanElement;
}

interface Counts {
  idle: number;
  need: number;
  needUnconf: number;
  quiet: number;
  running: number;
  unconf: number;
  unknown: number;
}

interface Summary {
  n: Counts;
  silent: number;
  waiting: SessionRow[];
}

interface ThreadView {
  button: HTMLButtonElement;
  error: HTMLParagraphElement;
  id: string;
  input: HTMLTextAreaElement;
  list: HTMLOListElement;
  loadToken: number;
  messages: DialogueMessage[] | null;
  root: HTMLElement;
}

type StreamMessage =
  | { machines: MachineRow[]; sequence: number; sessions: SessionRow[]; type: "snapshot" }
  | { sequence: number; session: SessionRow; type: "session" }
  | { thread_id: string; type: "thread" }
  | { machine: MachineRow; online?: unknown; type: "machine" };

// ---------- copy (spec §2) ----------

const STALE_S = PERF.machineStaleMs / 1000;
const QUIET_S = 300;
const FAILED_RED_S = 86_400;
const EVENTS_SHOWN = 12;
// Fallback only, for a machine notice from an older Worker without the online flag. Online
// notices carry a heartbeat at most one write throttle old, offline notices one at least
// machineStaleMs old; classify at the midpoint.
const LEGACY_NOTICE_ONLINE_MS = (PERF.heartbeatWriteThrottleMs + PERF.machineStaleMs) / 2;

const CLI: Record<CliKind, string> = { "claude-code": "Claude Code", codex: "Codex" };
const CLI_SHORT: Record<CliKind, string> = { "claude-code": "Claude", codex: "Codex" };
const LIFE: Record<Lifecycle, string> = { active: "進行中", ended: "終了", failed: "失敗" };
const ACT: Record<Activity, string> = { idle: "アイドル", running: "作業中", unknown: "状態不明" };
const ATT: Record<Attention, string> = {
  elicitation: "MCP回答待ち",
  needs_approval: "承認待ち",
  needs_input: "入力待ち",
  none: "対応不要",
};
const LABEL: Record<Kind, string> = {
  elicitation: ATT.elicitation,
  ended: "終了",
  failed: "失敗",
  "failed-old": "失敗",
  idle: ACT.idle,
  needs_approval: ATT.needs_approval,
  needs_input: ATT.needs_input,
  quiet: "作業中・更新なし",
  running: ACT.running,
  unknown: ACT.unknown,
};
const MARKER: Record<Kind, string> = {
  elicitation: "mk-att",
  ended: "mk-ended",
  failed: "mk-failed",
  "failed-old": "mk-failed mk-old",
  idle: "mk-idle",
  needs_approval: "mk-att",
  needs_input: "mk-att",
  quiet: "mk-unk",
  running: "mk-run",
  unknown: "mk-unk",
};
const CALL: Record<WaitKind, string> = {
  elicitation: "MCPサーバーからの質問への回答を待っています",
  needs_approval: "ツール実行の承認を待っています",
  needs_input: "あなたの入力を待っています",
};
const CALL_WAS: Record<WaitKind, string> = {
  elicitation: "最後の報告では、MCP回答待ちでした",
  needs_approval: "最後の報告では、承認待ちでした",
  needs_input: "最後の報告では、入力待ちでした",
};
const MSTATE: Record<MachineState, string> = {
  backlog: "送信遅れ",
  fresh: "受信中",
  silent: "途絶",
};
const GLOSS: Record<string, string> = {
  Notification: "通知",
  PermissionDenied: "許可の拒否",
  PermissionRequest: "許可の要求",
  PostToolUse: "ツール完了",
  PreToolUse: "ツール開始",
  SessionEnd: "セッション終了",
  SessionStart: "セッション開始",
  Stop: "応答完了",
  StopFailure: "異常終了",
  SubagentStart: "サブエージェント開始",
  SubagentStop: "サブエージェント終了",
  UserPromptSubmit: "プロンプト送信",
};
const STATUS_LABELS: Record<DialogueStatus, string> = {
  answered: "回答済み",
  delivered: "配送済み",
  expired: "期限切れ",
  failed: "失敗",
  held_busy: "保留（実行中）",
  queued: "送信待ち",
  running: "実行中",
};
const PENDING_STATUSES: ReadonlySet<DialogueStatus> = new Set([
  "queued",
  "delivered",
  "running",
  "held_busy",
]);
const AUTHOR_LABELS: Record<DialogueAuthor, string> = {
  agent: "エージェント",
  muse: "Muse",
  pen: "あなた",
};
const THEME_GROUPS: { label: string | null; themes: [string, string][] }[] = [
  { label: null, themes: [["auto", "自動"]] },
  {
    label: "明るいテーマ",
    themes: [
      ["std-light", "標準 ライト"],
      ["solarized-light", "Solarized Light"],
      ["github-light", "GitHub Light"],
    ],
  },
  {
    label: "暗いテーマ",
    themes: [
      ["std-dark", "標準 ダーク"],
      ["solarized-dark", "Solarized Dark"],
      ["nord", "Nord"],
    ],
  },
];
const THEME_KEY = "agent-board.theme";

// ---------- state ----------

const sessions = new Map<string, SessionRow>();
const machines = new Map<string, MachineRow>();
// Server-pushed online state per machine. Machines absent here age locally.
const serverOnline = new Map<string, boolean>();
const events = new Map<string, StoredEvent[]>();
const eventsFailed = new Set<string>();
let eventsVersion = 0;
let eventsToken = 0;

let projects: Project[] = [];
const projByKey = new Map<string, Project>();
// Project assignment is frozen at first sight and reset only at a sort moment.
const projOf = new Map<string, string>();
const knownProjects = new Set<string>();
const expanded = new Set<string>();
const endedOpen = new Set<string>();

const rowEls = new Map<string, Row[]>();
const waitEls = new Map<string, Row>();
const projEls = new Map<string, ProjectEls>();
let waitOrder: string[] = [];

const threads = new Map<string, ThreadView>();

let selection: Selection = { kind: "overview" };
let conn: Conn = "connecting";
let lostAt: string | null = null;
let lastSequence = 0;
let sorted = false;
let resyncing = false;
let mainMode = "";
let mainSig = "";

// ---------- DOM helpers ----------

type Child = Node | string | null | undefined | false;
type Props = Record<string, string | number | boolean | null | undefined>;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...kids: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = String(v);
      else if (k === "text") el.textContent = String(v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

function setText(el: Element, v: string): void {
  if (el.textContent !== v) el.textContent = v;
}
function setClass(el: Element, v: string): void {
  if (el.className !== v) el.className = v;
}
function setAttr(el: Element, k: string, v: string): void {
  if (el.getAttribute(k) !== v) el.setAttribute(k, v);
}

const waitList = byId<HTMLUListElement>("wait-list");
const projList = byId<HTMLUListElement>("proj-list");
const mainEl = byId<HTMLElement>("main");
const mainIn = byId<HTMLElement>("main-in");
const themeSelect = byId<HTMLSelectElement>("theme");
const announcer = byId<HTMLElement>("announce");
const favicon = byId<HTMLLinkElement>("favicon");
const sideEl = document.querySelector<HTMLElement>(".side");
const detailTop = h("div");
const detailBottom = h("div");
const museTop = h("div");

// ---------- time ----------

function secs(now: number, iso: string): number {
  return Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
}
function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function fmtFull(s: number): string {
  if (s < 60) return `${s}秒`;
  if (s < 3600) return `${Math.floor(s / 60)}分${pad(s % 60)}秒`;
  if (s < 86400) return `${Math.floor(s / 3600)}時間${pad(Math.floor((s % 3600) / 60))}分`;
  return `${Math.floor(s / 86400)}日${Math.floor((s % 86400) / 3600)}時間`;
}
function fmtShort(s: number): string {
  if (s < 60) return `${s}秒`;
  if (s < 3600) return `${Math.floor(s / 60)}分`;
  if (s < 86400) return `${Math.floor(s / 3600)}時間`;
  return `${Math.floor(s / 86400)}日`;
}
function clock(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function clipped(text: string, limit: number): boolean {
  return text.length >= limit;
}
function shown(text: string, limit: number): string {
  return clipped(text, limit) ? `${text}…` : text;
}

interface AgeOptions {
  full?: boolean;
  strong?: boolean;
  suffix?: string;
}
function ageText(iso: string, full: boolean, suffix: string): string {
  const s = secs(Date.now(), iso);
  return (full ? fmtFull(s) : fmtShort(s)) + suffix;
}
function ageSpan(iso: string, opts: AgeOptions = {}): HTMLSpanElement {
  const el = h("span", {
    class: `age${opts.strong ? " strong" : ""}`,
    "data-at": iso,
    "data-f": opts.full ? "full" : "short",
    "data-suffix": opts.suffix ?? "",
  });
  el.textContent = ageText(iso, opts.full === true, opts.suffix ?? "");
  return el;
}
function tickAges(): void {
  for (const el of document.querySelectorAll<HTMLElement>(".age[data-at]")) {
    setText(el, ageText(el.dataset.at ?? "", el.dataset.f === "full", el.dataset.suffix ?? ""));
  }
}

// ---------- derived state ----------

function machineSilent(m: MachineRow, now: number): boolean {
  const online = serverOnline.get(m.machine_id);
  if (online !== undefined) return !online;
  return secs(now, m.last_heartbeat_at) > STALE_S;
}
function machineState(m: MachineRow, now: number): MachineState {
  if (machineSilent(m, now)) return "silent";
  return m.spool_depth > 0 ? "backlog" : "fresh";
}
function newestSender(): string {
  let best = "0";
  for (const m of machines.values()) {
    if (m.sender_version.localeCompare(best, undefined, { numeric: true }) > 0) {
      best = m.sender_version;
    }
  }
  return best;
}

function projectOf(cwd: string): { key: string; name: string } {
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  const name = parts[parts.length - 1] ?? "";
  return { key: name.toLowerCase(), name };
}

// Priority: ended/failed > silent machine > attention > activity (spec §3.1).
function view(s: SessionRow, now: number): View {
  const m = machines.get(s.machine_id);
  const age = secs(now, s.last_event_at);
  let kind: Kind;
  let unconf = false;
  let att = false;
  if (s.lifecycle === "failed") kind = age > FAILED_RED_S ? "failed-old" : "failed";
  else if (s.lifecycle === "ended") kind = "ended";
  else {
    unconf = !m || machineSilent(m, now);
    if (s.attention !== "none") {
      kind = s.attention;
      att = true;
    } else if (s.activity === "running") kind = !unconf && age > QUIET_S ? "quiet" : "running";
    else kind = s.activity;
  }
  const muted = unconf || kind === "ended" || kind === "failed-old";
  return {
    ageAt: att && !unconf && s.attention_evidence ? s.attention_evidence.at : s.last_event_at,
    ageStrong: (att && !unconf) || kind === "quiet",
    att,
    dim: muted,
    kind,
    lab: att
      ? "lab lab-amber"
      : kind === "failed"
        ? "lab lab-red"
        : muted
          ? "lab lab-muted"
          : "lab",
    label: (unconf ? "未確認・" : "") + LABEL[kind],
    mk: unconf ? (att ? "mk mk-att-unk" : "mk mk-unk") : `mk ${MARKER[kind]}`,
    unconf,
  };
}
function waitAt(s: SessionRow): string {
  return s.attention_evidence ? s.attention_evidence.at : s.last_event_at;
}
function titleOf(s: SessionRow): string {
  return s.title ? shown(s.title, TITLE_LIMIT) : "タイトルなし";
}
function projectFor(id: string): Project | undefined {
  const key = projOf.get(id);
  return key === undefined ? undefined : projByKey.get(key);
}
function lingering(s: SessionRow): boolean {
  return (
    s.lifecycle !== "active" && (projectFor(s.session_id)?.active.includes(s.session_id) ?? false)
  );
}
function selectedId(): string | null {
  return selection.kind === "session" ? selection.id : null;
}

// ---------- sidebar ----------

const CHEV =
  '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M4 2 8 6 4 10" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
function chev(): HTMLSpanElement {
  const c = h("span", { class: "chev" });
  c.innerHTML = CHEV;
  return c;
}

// One back control, always the first child of the main pane so it can stay pinned while the
// detail scrolls on a narrow screen.
const backBar = h("button", { class: "back", "data-back": "1", type: "button" });
backBar.append(chev(), "一覧");

function makeRow(id: string, where: Row["where"]): Row {
  const mk = h("span", { class: "mk" });
  const t = h("span", { class: "row-t" });
  const lab = h("span", { class: "lab" });
  const meta = h("span", { class: "meta" });
  const age = ageSpan(new Date(0).toISOString());
  const btn = h(
    "button",
    { class: "row", "data-sel": id, type: "button" },
    mk,
    h("span", { class: "row-b" }, t, h("span", { class: "row-m" }, lab, meta, age)),
  );
  const row: Row = { age, btn, lab, li: h("li", null, btn), meta, mk, sig: "", t, where };
  const list = rowEls.get(id);
  if (list) list.push(row);
  else rowEls.set(id, [row]);
  return row;
}

function paintRow(r: Row, s: SessionRow, v: View): void {
  const isSel = selectedId() === s.session_id;
  const projLabel = projectFor(s.session_id)?.label ?? "";
  const sig = [
    v.kind,
    v.unconf,
    v.ageAt,
    v.ageStrong,
    v.dim,
    s.title,
    s.machine_id,
    s.cli,
    s.subagent_count,
    projLabel,
    isSel,
  ].join("|");
  if (sig === r.sig) return;
  r.sig = sig;
  setClass(r.mk, v.mk);
  setClass(r.btn, `row${v.dim ? " is-dim" : ""}`);
  setAttr(r.btn, "aria-current", isSel ? "true" : "false");
  setText(r.t, titleOf(s));
  setClass(r.lab, v.lab);
  setText(r.lab, v.label);
  const meta = r.where === "wait" ? [projLabel, s.machine_id] : [s.machine_id, CLI_SHORT[s.cli]];
  if (r.where !== "wait" && s.subagent_count) meta.push(`サブ${s.subagent_count}`);
  setText(r.meta, `· ${meta.join(" · ")}`);
  setClass(r.age, `age${v.ageStrong ? " strong" : ""}`);
  if (r.age.dataset.at !== v.ageAt) {
    r.age.dataset.at = v.ageAt;
    setText(r.age, ageText(v.ageAt, false, ""));
  }
}

function buildProject(p: Project): ProjectEls {
  const name = h("span", { class: `proj-name${p.name ? "" : " plain"}`, text: p.label });
  const tags = h("span", { class: "proj-tags" });
  const n = h("span", { class: "proj-n" });
  const btn = h(
    "button",
    { "aria-expanded": "false", class: "proj", "data-proj": p.key, type: "button" },
    chev(),
    name,
    tags,
    n,
  );
  const kids = h("ul", { class: "proj-kids", hidden: true });
  for (const id of p.active) kids.append(makeRow(id, "tree").li);
  const endN = h("span", { class: "endt-l" });
  const endTags = h("span");
  const endBtn = h(
    "button",
    { "aria-expanded": "false", class: "endt", "data-ended": p.key, type: "button" },
    chev(),
    endN,
    endTags,
  );
  const endKids = h("ul", { class: "ended-kids", hidden: true });
  for (const id of p.ended) endKids.append(makeRow(id, "tree").li);
  const endLi = h("li", null, endBtn, endKids);
  kids.append(endLi);
  const els: ProjectEls = {
    btn,
    endBtn,
    endKids,
    endLi,
    endN,
    endTags,
    kids,
    li: h("li", null, btn, kids),
    n,
    sig: "",
    tags,
  };
  projEls.set(p.key, els);
  return els;
}

function treeZero(): void {
  const zero = projects.length
    ? null
    : h("li", {
        class: "tree-zero",
        id: "tree-zero",
        text: machines.size
          ? "進行中・終了ともにセッションはありません。"
          : "プロジェクトはまだありません。",
      });
  const existing = document.getElementById("tree-zero");
  if (zero && existing) setText(existing, zero.textContent ?? "");
  else if (zero) projList.append(zero);
  else existing?.remove();
}

function buildSidebar(): void {
  rowEls.clear();
  waitEls.clear();
  projEls.clear();
  waitList.replaceChildren();
  projList.replaceChildren(...projects.map((p) => buildProject(p).li));
  treeZero();
}

// Sort moment (initial load, tab returning from hidden). Rebuilds the tree in name order.
function resort(): void {
  projects = [];
  projByKey.clear();
  projOf.clear();
  for (const s of sessions.values()) {
    const { key, name } = projectOf(s.cwd);
    let p = projByKey.get(key);
    if (!p) {
      p = {
        active: [],
        ended: [],
        hadActive: false,
        key,
        label: name || "作業ディレクトリ不明",
        name,
      };
      projByKey.set(key, p);
    }
    projOf.set(s.session_id, key);
    (s.lifecycle === "active" ? p.active : p.ended).push(s.session_id);
  }
  const lastAt = (id: string) => sessions.get(id)?.last_event_at ?? "";
  const byRecent = (a: string, b: string) => lastAt(b).localeCompare(lastAt(a));
  projects = [...projByKey.values()];
  for (const p of projects) {
    p.active.sort(byRecent);
    p.ended.sort(byRecent);
    p.hadActive = p.active.length > 0;
  }
  projects.sort((a, b) => {
    if (!a.name !== !b.name) return a.name ? -1 : 1;
    if (a.hadActive !== b.hadActive) return a.hadActive ? -1 : 1;
    return a.key.localeCompare(b.key);
  });
  for (const p of projects) {
    if (knownProjects.has(p.key)) continue;
    knownProjects.add(p.key);
    if (p.hadActive) expanded.add(p.key);
  }
  sorted = true;
  buildSidebar();
}

// A session first seen between sort moments goes to the end of its project's list. A new
// project goes to the end of the active-projects group; nothing above it moves.
function placeNew(s: SessionRow): void {
  const { key, name } = projectOf(s.cwd);
  const active = s.lifecycle === "active";
  projOf.set(s.session_id, key);
  let p = projByKey.get(key);
  if (!p) {
    p = {
      active: [],
      ended: [],
      hadActive: active,
      key,
      label: name || "作業ディレクトリ不明",
      name,
    };
    projByKey.set(key, p);
    let at = projects.length;
    if (key !== "") {
      const found = active
        ? projects.findIndex((q) => !q.hadActive || q.key === "")
        : projects.findIndex((q) => q.key === "");
      if (found >= 0) at = found;
    }
    (active ? p.active : p.ended).push(s.session_id);
    const els = buildProject(p);
    const before = projects[at];
    projList.insertBefore(els.li, before ? (projEls.get(before.key)?.li ?? null) : null);
    projects.splice(at, 0, p);
    knownProjects.add(key);
    if (active) expanded.add(key);
    treeZero();
    return;
  }
  const els = projEls.get(key);
  if (!els) return;
  if (active) {
    p.active.push(s.session_id);
    els.kids.insertBefore(makeRow(s.session_id, "tree").li, els.endLi);
  } else {
    p.ended.push(s.session_id);
    els.endKids.append(makeRow(s.session_id, "tree").li);
  }
}

function putSession(s: SessionRow): void {
  sessions.set(s.session_id, s);
  if (sorted && !projOf.has(s.session_id)) placeNew(s);
}

function emptyCounts(): Counts {
  return { idle: 0, need: 0, needUnconf: 0, quiet: 0, running: 0, unconf: 0, unknown: 0 };
}

function paintSidebar(now: number): Summary {
  const n = emptyCounts();
  const waiting: SessionRow[] = [];
  const per = new Map<string, { active: number; failed: number; wait: number }>();
  for (const s of sessions.values()) {
    const v = view(s, now);
    for (const r of rowEls.get(s.session_id) ?? []) paintRow(r, s, v);
    const key = projOf.get(s.session_id) ?? "";
    let c = per.get(key);
    if (!c) {
      c = { active: 0, failed: 0, wait: 0 };
      per.set(key, c);
    }
    if (v.kind === "failed") c.failed += 1;
    if (s.lifecycle !== "active") continue;
    c.active += 1;
    if (v.att) {
      c.wait += 1;
      waiting.push(s);
      if (v.unconf) n.needUnconf += 1;
      else n.need += 1;
    } else if (v.unconf) n.unconf += 1;
    else if (
      v.kind === "running" ||
      v.kind === "quiet" ||
      v.kind === "idle" ||
      v.kind === "unknown"
    )
      n[v.kind] += 1;
  }

  // Oldest wait first, so a new wait always lands at the end and existing rows stay put.
  waiting.sort((a, b) => waitAt(a).localeCompare(waitAt(b)));
  waitOrder = waiting.map((s) => s.session_id);
  const keep = new Set(waitOrder);
  for (const [id, r] of waitEls) {
    if (keep.has(id)) continue;
    r.li.remove();
    waitEls.delete(id);
    rowEls.set(
      id,
      (rowEls.get(id) ?? []).filter((x) => x !== r),
    );
  }
  const zero = document.getElementById("wait-zero");
  if (!waiting.length && !zero) {
    waitList.append(
      h("li", { class: "wait-zero", id: "wait-zero", text: "対応待ちはありません。" }),
    );
  }
  if (waiting.length && zero) zero.remove();
  waiting.forEach((s, i) => {
    let r = waitEls.get(s.session_id);
    if (!r) {
      r = makeRow(s.session_id, "wait");
      waitEls.set(s.session_id, r);
      paintRow(r, s, view(s, now));
    }
    if (waitList.children[i] !== r.li) waitList.insertBefore(r.li, waitList.children[i] ?? null);
  });
  const wn = byId("wait-n");
  setClass(wn, n.need ? "tag" : "");
  setText(wn, n.need ? String(n.need) : waiting.length ? "" : "0");
  setText(byId("wait-note"), n.needUnconf ? `ほか未確認 ${n.needUnconf}件` : "");

  for (const p of projects) {
    const e = projEls.get(p.key);
    if (!e) continue;
    const c = per.get(p.key) ?? { active: 0, failed: 0, wait: 0 };
    const open = expanded.has(p.key);
    const endOpen = endedOpen.has(p.key);
    const sig = [c.wait, c.failed, c.active, open, endOpen, p.ended.length].join("|");
    if (sig === e.sig) continue;
    e.sig = sig;
    setAttr(e.btn, "aria-expanded", String(open));
    e.kids.hidden = !open;
    e.tags.replaceChildren();
    if (c.wait) e.tags.append(h("span", { class: "tag", text: `待ち${c.wait}` }));
    if (c.failed) e.tags.append(h("span", { class: "cnt-red", text: `失敗${c.failed}` }));
    setText(e.n, c.active ? `進行中${c.active}` : "終了のみ");
    e.endLi.hidden = p.ended.length === 0;
    setAttr(e.endBtn, "aria-expanded", String(endOpen));
    e.endKids.hidden = !endOpen;
    setText(e.endN, `終了・失敗 ${p.ended.length}件`);
    e.endTags.replaceChildren();
    if (c.failed) e.endTags.append(h("span", { class: "cnt-red", text: `失敗${c.failed}` }));
  }

  const parts: string[] = [];
  if (n.running) parts.push(`作業中${n.running}`);
  if (n.quiet) parts.push(`更新なし${n.quiet}`);
  if (n.idle) parts.push(`アイドル${n.idle}`);
  if (n.unknown) parts.push(`状態不明${n.unknown}`);
  if (n.unconf + n.needUnconf) parts.push(`未確認${n.unconf + n.needUnconf}`);
  setText(byId("over-sum"), parts.join(" · "));
  setAttr(byId("nav-over"), "aria-current", selection.kind === "overview" ? "true" : "false");
  setAttr(byId("nav-muse"), "aria-current", selection.kind === "muse" ? "true" : "false");
  setText(byId("muse-sum"), museAwaiting() ? "回答待ち" : "");

  const lost = conn !== "live";
  document.body.dataset.conn = lost ? "lost" : "live";
  const connEl = byId("conn");
  if (connEl.dataset.sig !== conn) {
    connEl.dataset.sig = conn;
    setClass(connEl, `conn${conn === "lost" ? " is-lost" : ""}`);
    connEl.replaceChildren(
      h("span", { class: lost ? "mk mk-silent" : "mk mk-run" }),
      conn === "live" ? "接続済み" : conn === "lost" ? "切断" : "接続しています",
    );
  }
  let silent = 0;
  for (const m of machines.values()) if (machineSilent(m, now)) silent += 1;
  const fm = byId("foot-m");
  const fsig = `${machines.size}|${silent}`;
  if (fm.dataset.sig !== fsig) {
    fm.dataset.sig = fsig;
    fm.replaceChildren(`マシン ${machines.size}台`);
    if (silent) fm.append(" · ", h("span", { class: "bad", text: `途絶 ${silent}台` }));
  }

  const title =
    conn === "lost"
      ? "切断 · Agent Board"
      : n.need
        ? `対応待ち${n.need}件 · Agent Board`
        : "Agent Board";
  if (document.title !== title) document.title = title;
  setFavicon(conn === "lost" ? "lost" : n.need ? "wait" : "none");
  return { n, silent, waiting };
}

// Colours come from the theme tokens, so the favicon follows the theme.
function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
let iconSig = "";
function setFavicon(state: "none" | "wait" | "lost"): void {
  const sig = `${state}|${document.documentElement.dataset.theme ?? ""}`;
  if (sig === iconSig) return;
  iconSig = sig;
  const paint =
    state === "none"
      ? `fill="none" stroke="${token("--ink-4")}" stroke-width="2"`
      : state === "wait"
        ? `fill="${token("--wait-fill")}" stroke="${token("--wait-edge")}" stroke-width="1"`
        : `fill="none" stroke="${token("--fail-text")}" stroke-width="2" stroke-dasharray="3 2"`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" ${paint}/></svg>`;
  favicon.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// ---------- theme ----------

const darkQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
const themeIds = new Set(THEME_GROUPS.flatMap((g) => g.themes.map(([id]) => id)));

function applyTheme(choice: string): void {
  const valid = themeIds.has(choice) ? choice : "auto";
  const root = document.documentElement;
  root.dataset.themeChoice = valid;
  root.dataset.theme = valid === "auto" ? (darkQuery?.matches ? "std-dark" : "std-light") : valid;
  themeSelect.value = valid;
}
function saveTheme(choice: string): boolean {
  try {
    localStorage.setItem(THEME_KEY, choice);
    return true;
  } catch {
    return false;
  }
}

themeSelect.replaceChildren(
  ...THEME_GROUPS.flatMap((g) => {
    const options = g.themes.map(([value, label]) => h("option", { text: label, value }));
    return g.label ? [h("optgroup", { label: g.label }, ...options)] : options;
  }),
);
themeSelect.addEventListener("change", () => {
  saveTheme(themeSelect.value);
  applyTheme(themeSelect.value);
  paintAll();
});
darkQuery?.addEventListener("change", () => {
  if (document.documentElement.dataset.themeChoice !== "auto") return;
  applyTheme("auto");
  paintAll();
});

// ---------- dialogue ----------

function threadPath(threadId: string): string {
  return threadId === MUSE_THREAD_ID
    ? "/api/muse/messages"
    : `/api/sessions/${encodeURIComponent(threadId)}/messages`;
}

function renderMessage(message: DialogueMessage): HTMLLIElement {
  const head = h(
    "p",
    { class: "msg-h" },
    h("strong", { text: AUTHOR_LABELS[message.author] }),
    h("span", { class: "mono", text: clock(message.created_at) }),
  );
  if (message.author === "pen") {
    head.append(
      h("span", {
        class: "chip",
        "data-status": message.status,
        text: STATUS_LABELS[message.status],
      }),
    );
    if (message.reason) head.append(h("span", { class: "msg-why", text: `（${message.reason}）` }));
  }
  return h(
    "li",
    { class: "msg", "data-author": message.author },
    head,
    h("p", { class: "msg-b", text: message.body }),
  );
}

function renderThread(tv: ThreadView): void {
  if (tv.messages === null) {
    tv.list.replaceChildren(h("li", { class: "thread-zero", text: "読み込んでいます。" }));
    return;
  }
  if (!tv.messages.length) {
    tv.list.replaceChildren(
      h("li", { class: "thread-zero", text: "まだメッセージはありません。" }),
    );
    return;
  }
  tv.list.replaceChildren(...tv.messages.map(renderMessage));
}

async function loadThread(threadId: string): Promise<void> {
  const tv = threads.get(threadId);
  if (!tv) return;
  tv.loadToken += 1;
  const token = tv.loadToken;
  try {
    const response = await fetch(threadPath(threadId));
    const data = response.ok ? ((await response.json()) as { messages: DialogueMessage[] }) : null;
    if (token !== tv.loadToken) return;
    if (!data) {
      threadLoadFailed(tv);
      return;
    }
    tv.messages = data.messages;
    renderThread(tv);
    if (threadId === MUSE_THREAD_ID) paintAll();
  } catch {
    if (token === tv.loadToken) threadLoadFailed(tv);
  }
}

function threadLoadFailed(tv: ThreadView): void {
  if (tv.messages === null) {
    tv.list.replaceChildren(
      h("li", { class: "thread-zero", text: "スレッドを読み込めませんでした。" }),
    );
  } else setText(tv.error, "スレッドを読み込めませんでした");
}

// One node per thread. It is moved, never rebuilt, so a draft and its focus survive updates.
function threadView(threadId: string): ThreadView {
  const existing = threads.get(threadId);
  if (existing) return existing;
  const list = h("ol", { class: "thread" });
  const input = h("textarea", { "aria-label": "メッセージ", rows: 3 });
  input.maxLength = PERF.dialogueMessageMaxChars;
  const button = h("button", { class: "send", text: "送信", type: "submit" });
  const error = h("p", { class: "composer-err", role: "status" });
  const form = h(
    "form",
    { class: "composer" },
    input,
    h("div", { class: "composer-row" }, button, error),
  );
  const root =
    threadId === MUSE_THREAD_ID
      ? h("section", { class: "blk dlg card" }, list, form)
      : h("section", { class: "blk dlg card" }, h("h3", { text: "対話" }), list, form);
  const tv: ThreadView = {
    button,
    error,
    id: threadId,
    input,
    list,
    loadToken: 0,
    messages: null,
    root,
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const body = input.value.trim();
    if (!body || button.disabled) return;
    button.disabled = true;
    setText(error, "");
    void fetch(threadPath(threadId), {
      body: JSON.stringify({ body }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
      .then(async (response) => {
        if (response.ok) input.value = "";
        else setText(error, `送信に失敗しました（${response.status}）`);
        await loadThread(threadId);
      })
      .catch(() => {
        setText(error, "送信に失敗しました");
      })
      .finally(() => {
        button.disabled = false;
      });
  });
  threads.set(threadId, tv);
  renderThread(tv);
  return tv;
}

function museAwaiting(): boolean {
  const messages = threads.get(MUSE_THREAD_ID)?.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.author === "pen") return PENDING_STATUSES.has(m.status);
  }
  return false;
}

// ---------- main pane ----------

function blk(title: string, sub: string, ...kids: Child[]): HTMLElement {
  const head = h("h3", null, title);
  if (sub) head.append(h("span", { class: "sub", text: sub }));
  return h("section", { class: "blk" }, head, ...kids);
}
function card(title: string, sub: string, ...kids: Child[]): HTMLElement {
  const el = blk(title, sub, ...kids);
  el.classList.add("card");
  return el;
}
function textBlock(
  title: string,
  sub: string,
  text: string,
  limit: number,
  emptyCopy: string,
): HTMLElement {
  if (!text) return blk(title, sub, h("p", { class: "txt none", text: emptyCopy }));
  const p = h("p", { class: "txt", text: shown(text, limit) });
  if (clipped(text, limit)) {
    p.append(h("span", { class: "clip", text: `保存時に${limit}文字で切られています。` }));
  }
  return blk(title, sub, p);
}
function fact(dl: HTMLElement, k: string, node: Child, cls?: string): void {
  dl.append(h("dt", { text: k }), h("dd", { class: cls ?? null }, node));
}
function lostBar(): HTMLElement | null {
  if (conn !== "lost" || !lostAt) return null;
  return h(
    "p",
    { class: "lost-bar" },
    "ボードとの接続が切れています（",
    ageSpan(lostAt, { full: true, suffix: "前" }),
    "から）。表示は切断前の状態です。再接続を試みています。",
  );
}

function activeOn(machineId: string): number {
  let c = 0;
  for (const s of sessions.values())
    if (s.machine_id === machineId && s.lifecycle === "active") c += 1;
  return c;
}

function machineLine(m: MachineRow, now: number): HTMLLIElement {
  const st = machineState(m, now);
  const newest = newestSender();
  const active = activeOn(m.machine_id);
  const ds = h("span", { class: "ds" });
  if (st === "silent") {
    ds.append(
      h(
        "span",
        { class: "bad" },
        "途絶 · ハートビートが",
        ageSpan(m.last_heartbeat_at, { full: true }),
        "届いていません",
      ),
      "。電源オフかsenderの停止です。",
    );
  } else if (secs(now, m.last_heartbeat_at) > STALE_S) {
    // The server confirmed this machine online; heartbeats themselves are not pushed, so the
    // local copy's age would be misleading.
    ds.append(MSTATE[st]);
  } else {
    ds.append(`${MSTATE[st]} · ハートビート `, ageSpan(m.last_heartbeat_at, { suffix: "前" }));
  }
  ds.append(" · ");
  if (st === "backlog")
    ds.append(h("b", { text: `未送信 ${m.spool_depth}件（表示が遅れています）` }));
  else ds.append(`${st === "silent" ? "最後の報告で未送信 " : "未送信 "}${m.spool_depth}件`);
  ds.append(" · ");
  if (m.sender_version !== newest) {
    ds.append(h("b", { text: `sender ${m.sender_version}（最新は ${newest}）` }));
  } else ds.append(`sender ${m.sender_version}`);
  ds.append(` · ${active ? `進行中 ${active}件` : "セッションなし"}`);
  const mk = st === "silent" ? "mk mk-silent" : st === "backlog" ? "mk mk-unk" : "mk mk-run";
  return h(
    "li",
    { class: "li li-mc" },
    h("span", { class: mk }),
    h("span", { class: "nm mono", text: m.machine_id }),
    ds,
  );
}

function ovRow(s: SessionRow, v: View, withEvidence: boolean): HTMLLIElement {
  const p = projectFor(s.session_id);
  const meta = h(
    "span",
    { class: "ov-m" },
    h("span", { class: v.lab, text: v.label }),
    `${p?.label ?? ""} · ${s.machine_id} · ${CLI[s.cli]}${s.subagent_count ? ` · サブエージェント ${s.subagent_count}` : ""}`,
  );
  const body = h(
    "span",
    { class: "ov-body" },
    h("span", { class: "ov-t", text: titleOf(s) }),
    meta,
  );
  if (withEvidence) {
    const e = h(
      "span",
      { class: "ov-m" },
      "根拠イベント ",
      h("span", { class: "mono", text: s.attention_evidence?.event_name ?? "記録なし" }),
    );
    if (s.last_tool) e.append(" · 直前のツール ", h("span", { class: "mono", text: s.last_tool }));
    body.append(e);
  }
  const confirmedWait = v.att && !v.unconf;
  return h(
    "li",
    null,
    h(
      "button",
      {
        class: `ov-row${confirmedWait ? " is-att" : ""}`,
        "data-sel": s.session_id,
        type: "button",
      },
      h("span", { class: v.mk }),
      body,
      h(
        "span",
        { class: "ov-age" },
        ageSpan(v.ageAt, { full: true, strong: v.ageStrong }),
        confirmedWait ? " 経過" : " 前",
      ),
    ),
  );
}

function renderOverview(sum: Summary): Child[] {
  const now = Date.now();
  const kids: Child[] = [lostBar()];
  if (!machines.size) {
    kids.push(
      h(
        "div",
        { class: "empty card" },
        h("h2", { class: "ov-h", text: "まだどのマシンからも報告がありません" }),
        h("p", {
          text: "マシンのsenderが最初のハートビートを送ると、ここにプロジェクトとセッションが並びます。",
        }),
        h(
          "p",
          null,
          "マシンにフックの設定を入れてから、そのマシンで ",
          h("code", { text: "just doctor" }),
          " を実行してください。フックの有無、未送信の件数、senderのバージョン、最後に送信できた時刻、設定ファイルの場所を確認できます。",
        ),
      ),
    );
    return kids;
  }
  const n = sum.n;
  kids.push(h("h2", { class: "ov-h", text: "概要" }));
  const summary = h(
    "p",
    { class: "ov-sum" },
    h("b", { text: n.need ? `対応待ちが${n.need}件あります。` : "対応待ちはありません。" }),
  );
  const rest: string[] = [];
  if (n.running) rest.push(`作業中 ${n.running}件`);
  if (n.quiet) rest.push(`更新なし ${n.quiet}件`);
  if (n.idle) rest.push(`アイドル ${n.idle}件`);
  if (n.unknown) rest.push(`状態不明 ${n.unknown}件`);
  if (n.unconf + n.needUnconf) rest.push(`未確認 ${n.unconf + n.needUnconf}件`);
  if (rest.length) summary.append(`ほかは ${rest.join("、")}。`);
  if (sum.silent) {
    summary.append(
      h("span", {
        class: "bad",
        text: `ハートビートが途絶えているマシンが${sum.silent}台あります。`,
      }),
    );
  }
  kids.push(summary);

  const wl = h("ul", { class: "list" }, ...sum.waiting.map((s) => ovRow(s, view(s, now), true)));
  kids.push(
    card(
      "対応待ち",
      "待ちはじめが古い順",
      sum.waiting.length
        ? wl
        : h("p", { class: "zero", text: "いま、あなたの対応を待っているセッションはありません。" }),
    ),
  );

  const al = h("ul", { class: "list" });
  for (const p of projects) {
    for (const id of p.active) {
      const s = sessions.get(id);
      if (!s || s.lifecycle !== "active") continue;
      const v = view(s, now);
      if (!v.att) al.append(ovRow(s, v, false));
    }
  }
  kids.push(
    card(
      "進行中のセッション",
      "プロジェクト順",
      al.children.length ? al : h("p", { class: "zero", text: "進行中のセッションはありません。" }),
    ),
  );

  const machineBlock = card(
    "マシン",
    `${machines.size}台`,
    h("ul", { class: "list" }, ...[...machines.values()].map((m) => machineLine(m, now))),
  );
  machineBlock.id = "ov-machines";
  kids.push(machineBlock);

  const ended = [...sessions.values()]
    .filter((s) => s.lifecycle !== "active")
    .sort((a, b) => b.last_event_at.localeCompare(a.last_event_at));
  if (ended.length) {
    kids.push(
      card(
        "最近の終了・失敗",
        "新しい順に4件まで。終了したセッションは30日で消えます",
        h("ul", { class: "list" }, ...ended.slice(0, 4).map((s) => ovRow(s, view(s, now), false))),
      ),
    );
  }
  kids.push(
    h(
      "p",
      { class: "keys" },
      h("kbd", { text: "↑" }),
      " ",
      h("kbd", { text: "↓" }),
      " 移動　",
      h("kbd", { text: "Enter" }),
      " 開く　",
      h("kbd", { text: "←" }),
      " ",
      h("kbd", { text: "→" }),
      " プロジェクトの開閉　",
      h("kbd", { text: "a" }),
      " 次の対応待ち　",
      h("kbd", { text: "Esc" }),
      " 概要へ",
    ),
    h("p", {
      class: "ov-note",
      text: "承認や権限への応答は、このボードからはできません。各セッションへの指示や質問は、詳細の「対話」から送れます。",
    }),
  );
  return kids;
}

function renderDetailTop(s: SessionRow, v: View): Child[] {
  const m = machines.get(s.machine_id);
  const p = projectFor(s.session_id);
  const kids: Child[] = [];
  kids.push(
    h(
      "p",
      { class: "crumb" },
      h("span", { class: "mono", text: p?.label ?? "" }),
      h("span", { class: "sep", text: "/" }),
      `${s.machine_id} · ${CLI[s.cli]}`,
    ),
  );
  const title = h("h2", { class: "d-title", text: titleOf(s) });
  if (!s.title) title.append(h("span", { class: "sid mono", text: s.session_id.slice(0, 8) }));
  kids.push(title);

  const labClass =
    v.att && !v.unconf
      ? " tag"
      : v.att
        ? " is-amber"
        : v.kind === "failed"
          ? " is-red"
          : v.dim
            ? " is-muted"
            : "";
  const when = h("span", { class: "d-when" });
  if (v.att && !v.unconf) when.append(ageSpan(v.ageAt, { full: true }), " 経過");
  else if (v.unconf) {
    when.append("最後の報告は ", ageSpan(s.last_event_at, { full: true, suffix: "前" }));
  } else if (v.kind === "ended" || v.kind === "failed" || v.kind === "failed-old") {
    when.append(ageSpan(s.last_event_at, { full: true, suffix: "前" }));
  } else when.append("最終イベント ", ageSpan(s.last_event_at, { full: true, suffix: "前" }));
  kids.push(
    h(
      "p",
      { class: "d-state" },
      h("span", { class: v.mk }),
      h("span", { class: `d-label${labClass}`, text: v.label }),
      when,
    ),
  );

  if (s.attention !== "none" && s.lifecycle === "active") {
    const ev = s.attention_evidence;
    const call = h(
      "div",
      { class: `call${v.unconf ? " is-unconf" : ""}` },
      h("p", { class: "call-h", text: v.unconf ? CALL_WAS[s.attention] : CALL[s.attention] }),
      h(
        "dl",
        null,
        h("dt", { text: "根拠イベント" }),
        h(
          "dd",
          null,
          h("span", { class: "mono", text: ev ? ev.event_name : "記録なし" }),
          ev ? `　${clock(ev.at)} 受信` : "",
        ),
        h("dt", { text: "直前のツール" }),
        h(
          "dd",
          null,
          h("span", { class: "mono", text: s.last_tool ?? "なし" }),
          s.attention === "needs_input"
            ? null
            : h("span", { class: "hint", text: "　承認や回答の対象とは限りません" }),
        ),
      ),
      h("p", {
        class: "call-foot",
        text: `${s.attention === "needs_input" && s.last_message ? "質問の内容は、下の「最後の応答」にあります。" : ""}このボードからは応答できません。${s.machine_id} の端末で、このセッションに応答してください。`,
      }),
    );
    kids.push(call);
  }
  if (v.unconf) {
    kids.push(
      h(
        "p",
        { class: "note is-red" },
        h("span", { class: "mono", text: s.machine_id }),
        " からのハートビートが ",
        m ? ageSpan(m.last_heartbeat_at, { full: true }) : "",
        " 届いていません。下の内容は、最後に届いた状態です。",
      ),
    );
  }
  if (v.kind === "quiet") {
    kids.push(
      h("p", {
        class: "note",
        text: `作業中のまま、${QUIET_S / 60}分以上イベントが届いていません。時間のかかるツール実行と、止まっている状態は、このデータからは区別できません。`,
      }),
    );
  }
  if (lingering(s)) {
    kids.push(
      h("p", {
        class: "note",
        text: "表示中に終了したので、一覧では元の位置に残しています。次に並べ直すときに「終了・失敗」へ移ります。",
      }),
    );
  }

  const running = s.subagent_count;
  const stopped = s.subagents.length - running;
  const dims = h("dl", { class: "dims" });
  const dim = (k: string, val: Child, raw: string) =>
    dims.append(
      h(
        "div",
        { class: "dim" },
        h("dt", { text: k }),
        h("dd", null, val, raw ? h("span", { class: "raw mono", text: raw }) : null),
      ),
    );
  dim("セッション", LIFE[s.lifecycle], s.lifecycle);
  dim("動き", ACT[s.activity], s.activity);
  dim("対応", ATT[s.attention], s.attention);
  dim(
    "サブエージェント",
    s.subagents.length ? `作業中 ${running}` : "なし",
    s.subagents.length ? `停止 ${stopped}` : "",
  );
  dim(
    "最終イベント",
    ageSpan(s.last_event_at, { full: true, suffix: "前" }),
    clock(s.last_event_at),
  );
  kids.push(dims);
  const texts: Child[] = [];
  texts.push(
    textBlock(
      "依頼",
      "最初のプロンプト",
      s.title,
      TITLE_LIMIT,
      "プロンプトがまだ届いていないので、タイトルがありません。",
    ),
  );
  const sameAsTitle =
    s.last_prompt === s.title ||
    (clipped(s.title, TITLE_LIMIT) && s.last_prompt.startsWith(s.title));
  if (s.last_prompt && !sameAsTitle) {
    texts.push(textBlock("直近の指示", "このターンのプロンプト", s.last_prompt, PROMPT_LIMIT, ""));
  }
  texts.push(
    textBlock("最後の応答", "", s.last_message, MESSAGE_LIMIT, "応答はまだ記録されていません。"),
  );
  return [
    lostBar(),
    h("div", { class: "d-head card" }, ...kids),
    h("div", { class: "card" }, ...texts),
  ];
}

function renderDetailBottom(s: SessionRow, v: View): Child[] {
  const now = Date.now();
  const m = machines.get(s.machine_id);
  const p = projectFor(s.session_id);
  const kids: Child[] = [];
  if (s.subagents.length) {
    const running = s.subagent_count;
    kids.push(
      blk(
        "サブエージェント",
        `作業中 ${running} · 停止 ${s.subagents.length - running}`,
        h(
          "ul",
          { class: "list" },
          ...s.subagents.map((a) => {
            const run = a.status === "running";
            return h(
              "li",
              { class: `li li-sub${run ? "" : " is-stopped"}` },
              h("span", { class: run ? (v.unconf ? "mk mk-unk" : "mk mk-run") : "mk mk-ended" }),
              h("b", { class: "mono", text: a.agent_type }),
              h("span", { class: "id mono", text: a.agent_id }),
              h("span", { class: "st", text: run ? "作業中" : "停止" }),
            );
          }),
        ),
      ),
    );
  }

  const loaded = events.get(s.session_id);
  const evs = loaded ? [...loaded].reverse().slice(0, EVENTS_SHOWN) : [];
  const evidence = s.attention !== "none" ? s.attention_evidence : null;
  const list = h(
    "ul",
    { class: "list" },
    ...evs.map((e) => {
      const env = e.envelope;
      const d = h("span", { class: "d" }, GLOSS[env.event_name] ?? "");
      if (env.tool_name) d.append("　", h("span", { class: "mono", text: env.tool_name }));
      if (env.pulse_count && env.pulse_count > 1) d.append(` ×${env.pulse_count}`);
      if (env.notification_type) {
        d.append("　", h("span", { class: "mono", text: env.notification_type }));
      }
      if (env.agent_type) d.append("　", h("span", { class: "mono", text: env.agent_type }));
      if (evidence && e.received_at === evidence.at && env.event_name === evidence.event_name) {
        d.append(h("span", { class: v.unconf ? "tag tag-dash" : "tag", text: "根拠" }));
      }
      return h(
        "li",
        { class: "li li-ev" },
        h("span", { class: "t", text: clock(e.received_at) }),
        h("span", { class: "mono", text: env.event_name }),
        d,
      );
    }),
  );
  kids.push(
    blk(
      "イベント履歴",
      `新しい順に${EVENTS_SHOWN}件まで。保存は1セッション${PERF.eventsPerSessionCap}件・${PERF.eventRetentionDays}日まで`,
      evs.length
        ? list
        : h("p", {
            class: "zero",
            text: !loaded
              ? "読み込んでいます。"
              : eventsFailed.has(s.session_id)
                ? "イベント履歴を読み込めませんでした。"
                : "保存されているイベントはありません。",
          }),
    ),
  );

  if (m) kids.push(blk("マシン", "", h("ul", { class: "list" }, machineLine(m, now))));

  const info = h("dl", { class: "facts" });
  fact(
    info,
    "セッションID",
    h(
      "span",
      null,
      h("span", { class: "mono", text: s.session_id }),
      h("button", { class: "copy", "data-copy": s.session_id, text: "コピー", type: "button" }),
    ),
  );
  fact(
    info,
    "プロジェクト",
    h(
      "span",
      null,
      p?.name ? h("span", { class: "mono", text: p.name }) : (p?.label ?? ""),
      "　作業ディレクトリの末尾から判定",
    ),
  );
  fact(info, "作業ディレクトリ", h("span", { class: "mono", text: s.cwd || "報告なし" }));
  fact(info, "CLI", CLI[s.cli]);
  fact(info, "直前のツール", h("span", { class: "mono", text: s.last_tool ?? "なし" }));
  fact(info, "ツールイベント数", `${s.tool_pulses}（開始と完了を別々に数えます）`);
  if (s.dropped_tool_events) {
    fact(
      info,
      "取りこぼし",
      `senderが ${s.dropped_tool_events} 件のツールイベントを落としました。上の数は下限です。`,
      "warn",
    );
  }
  fact(info, "ボード通番", String(s.board_seq));
  kids.push(blk("セッション情報", "", info));
  return [h("div", { class: "card" }, ...kids)];
}

function renderMuseTop(): Child[] {
  return [
    lostBar(),
    h(
      "div",
      { class: "d-head card" },
      h("h2", { class: "ov-h", text: "Muse への相談" }),
      h("p", { class: "ov-sum", text: "Muse への相談です。返信はこのスレッドに届きます。" }),
    ),
  ];
}

function fill(el: HTMLElement, kids: Child[]): void {
  el.replaceChildren(
    ...kids.filter((k): k is Node | string => k !== null && k !== undefined && k !== false),
  );
}

function machineSig(m: MachineRow | undefined, now: number): string {
  if (!m) return "";
  return [
    machineState(m, now),
    m.spool_depth,
    m.sender_version,
    m.last_heartbeat_at,
    secs(now, m.last_heartbeat_at) > STALE_S,
  ].join(",");
}

// The dialogue node sits between the regions above and below it and is never detached while
// its session stays selected, so typing and IME composition survive live updates.
function renderMain(sum: Summary, force: boolean): void {
  const now = Date.now();
  const s = selection.kind === "session" ? sessions.get(selection.id) : undefined;
  if (selection.kind === "session" && !s) selection = { kind: "overview" };
  const mode = s ? `session:${s.session_id}` : selection.kind;
  const top = mainEl.scrollTop;
  const modeChanged = mode !== mainMode;
  let sig: string;
  if (s) {
    const v = view(s, now);
    sig = [
      conn,
      JSON.stringify(s),
      v.kind,
      v.unconf,
      machineSig(machines.get(s.machine_id), now),
      eventsVersion,
      newestSender(),
      lingering(s),
      projectFor(s.session_id)?.label ?? "",
    ].join("|");
    if (force || modeChanged || sig !== mainSig) {
      fill(detailTop, renderDetailTop(s, v));
      fill(detailBottom, renderDetailBottom(s, v));
      if (modeChanged)
        mainIn.replaceChildren(backBar, detailTop, threadView(s.session_id).root, detailBottom);
    }
  } else if (selection.kind === "muse") {
    sig = conn;
    if (force || modeChanged || sig !== mainSig) {
      fill(museTop, renderMuseTop());
      if (modeChanged) mainIn.replaceChildren(backBar, museTop, threadView(MUSE_THREAD_ID).root);
    }
  } else {
    const parts: string[] = [
      conn,
      String(machines.size),
      JSON.stringify(sum.n),
      String(sum.silent),
    ];
    for (const x of sessions.values()) {
      const w = view(x, now);
      parts.push(`${x.session_id}${w.kind}${w.unconf}${w.ageAt}${x.subagent_count}${x.title}`);
    }
    for (const m of machines.values()) parts.push(machineSig(m, now));
    sig = parts.join("|");
    if (force || modeChanged || sig !== mainSig) fill(mainIn, [backBar, ...renderOverview(sum)]);
  }
  mainSig = sig;
  mainMode = mode;
  mainEl.scrollTop = force || modeChanged ? 0 : top;
}

function paintAll(force = false): void {
  const sum = paintSidebar(Date.now());
  renderMain(sum, force);
  tickAges();
}

function tickMarker(id: string): void {
  for (const r of rowEls.get(id) ?? []) {
    r.mk.classList.remove("tick");
    void r.mk.offsetWidth;
    r.mk.classList.add("tick");
  }
}

// ---------- events ----------

async function loadEvents(id: string): Promise<void> {
  eventsToken += 1;
  const token = eventsToken;
  try {
    const response = await fetch(
      `/api/sessions/${encodeURIComponent(id)}/events?limit=${EVENTS_SHOWN}`,
    );
    const data = response.ok ? ((await response.json()) as { events: StoredEvent[] }) : null;
    if (token !== eventsToken) return;
    events.set(id, data?.events ?? []);
    if (data) eventsFailed.delete(id);
    else eventsFailed.add(id);
  } catch {
    if (token !== eventsToken) return;
    events.set(id, []);
    eventsFailed.add(id);
  }
  eventsVersion += 1;
  if (selectedId() === id) paintAll();
}

// ---------- selection / navigation ----------

// Below this width the list and the detail are two full screens (styles.css uses the same
// value). Opening the detail adds one history entry, so the browser's back returns to the list.
const narrow = window.matchMedia("(max-width: 760px)");
const PANE_STATE = "agent-board.pane";
type Pane = "list" | "main";
let listScroll = 0;

function detailEntry(state: unknown): boolean {
  return typeof state === "object" && state !== null && PANE_STATE in state;
}

// The list is hidden with display:none while the detail is open, and a sort moment can rebuild
// it meanwhile, so its scroll offset is kept here rather than trusted to the browser.
function showPane(pane: Pane): void {
  const body = document.body;
  if (body.dataset.pane === pane) return;
  if (pane === "main") listScroll = sideEl?.scrollTop ?? 0;
  body.dataset.pane = pane;
  if (pane !== "list") return;
  if (sideEl) sideEl.scrollTop = listScroll;
  document
    .querySelector<HTMLElement>('.side [aria-current="true"]')
    ?.focus({ preventScroll: true });
}

function openPane(): void {
  if (narrow.matches && document.body.dataset.pane !== "main") {
    history.pushState({ [PANE_STATE]: "main" }, "");
  }
  showPane("main");
}

// Same as the browser's back when the detail was opened here, so the two never stack.
function backToList(): void {
  if (detailEntry(history.state)) history.back();
  else showPane("list");
}

window.addEventListener("popstate", (ev) => {
  showPane(detailEntry(ev.state) ? "main" : "list");
});
// A reload keeps the entry's state but starts on the list; drop the marker so the next open
// pushes a fresh entry instead of stepping back onto this one.
if (detailEntry(history.state)) history.replaceState(null, "");

function select(next: Selection): void {
  selection = next.kind === "session" && !sessions.has(next.id) ? { kind: "overview" } : next;
  if (selection.kind === "session") {
    const p = projectFor(selection.id);
    if (p) {
      expanded.add(p.key);
      if (p.ended.includes(selection.id)) endedOpen.add(p.key);
    }
    void loadEvents(selection.id);
    threadView(selection.id);
    void loadThread(selection.id);
  } else if (selection.kind === "muse") {
    void loadThread(MUSE_THREAD_ID);
  }
  openPane();
  paintAll(true);
}

function sideButtons(): HTMLButtonElement[] {
  return [
    ...document.querySelectorAll<HTMLButtonElement>(
      ".side .nav-over, .side .row, .side .proj, .side .endt",
    ),
  ].filter((b) => b.offsetParent !== null);
}
function focusBtn(b: HTMLElement | null | undefined): void {
  if (!b) return;
  b.focus({ preventScroll: true });
  b.scrollIntoView({ block: "nearest" });
}
function toggle(set: Set<string>, key: string, want = !set.has(key)): void {
  if (want) set.add(key);
  else set.delete(key);
}

document.querySelector(".side")?.addEventListener("click", (ev) => {
  const b = (ev.target as Element | null)?.closest("button");
  if (!b) return;
  if (b.dataset.sel) select({ id: b.dataset.sel, kind: "session" });
  else if (b.dataset.proj !== undefined) {
    toggle(expanded, b.dataset.proj);
    paintAll();
  } else if (b.dataset.ended !== undefined) {
    toggle(endedOpen, b.dataset.ended);
    paintAll();
  } else if (b.id === "nav-over") select({ kind: "overview" });
  else if (b.id === "nav-muse") select({ kind: "muse" });
  else if (b.id === "foot-m") {
    select({ kind: "overview" });
    document.getElementById("ov-machines")?.scrollIntoView({ block: "start" });
  }
});

mainEl.addEventListener("click", (ev) => {
  const b = (ev.target as Element | null)?.closest("button");
  if (!b) return;
  if (b.dataset.back) backToList();
  else if (b.dataset.sel) select({ id: b.dataset.sel, kind: "session" });
  else if (b.dataset.copy) {
    const done = () => {
      b.textContent = "コピーしました";
      setTimeout(() => {
        b.textContent = "コピー";
      }, 1500);
    };
    if (navigator.clipboard?.writeText)
      navigator.clipboard.writeText(b.dataset.copy).then(done, done);
    else done();
  }
});

document.addEventListener("keydown", (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.isComposing) return;
  const target = ev.target as HTMLElement | null;
  const tag = target?.tagName;
  if (tag === "SELECT" || tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable)
    return;
  const key = ev.key;
  const ae = document.activeElement as HTMLElement | null;
  const inSide = !ae || ae === document.body || ae.closest(".side") !== null;
  if (key === "a") {
    if (!waitOrder.length) return;
    const at = waitOrder.indexOf(selectedId() ?? "");
    const next = waitOrder[(at + 1) % waitOrder.length];
    if (!next) return;
    select({ id: next, kind: "session" });
    focusBtn(waitEls.get(next)?.btn);
    return;
  }
  if (key === "Escape") {
    select({ kind: "overview" });
    return;
  }
  if (!inSide) return;
  const btns = sideButtons();
  const at = ae ? btns.indexOf(ae as HTMLButtonElement) : -1;
  if (key === "j" || key === "ArrowDown") {
    if (!btns.length) return;
    ev.preventDefault();
    focusBtn(btns[Math.min(btns.length - 1, at + 1)]);
  } else if (key === "k" || key === "ArrowUp") {
    if (!btns.length) return;
    ev.preventDefault();
    focusBtn(btns[Math.max(0, at < 0 ? 0 : at - 1)]);
  } else if (key === "ArrowRight" || key === "ArrowLeft") {
    const cur = at >= 0 ? btns[at] : undefined;
    if (!cur) return;
    const want = key === "ArrowRight";
    if (cur.dataset.proj !== undefined) {
      ev.preventDefault();
      if (expanded.has(cur.dataset.proj) !== want) {
        toggle(expanded, cur.dataset.proj, want);
        paintAll();
      }
    } else if (cur.dataset.ended !== undefined) {
      ev.preventDefault();
      if (endedOpen.has(cur.dataset.ended) !== want) {
        toggle(endedOpen, cur.dataset.ended, want);
        paintAll();
      }
    } else if (!want && cur.dataset.sel && cur.closest(".tree")) {
      ev.preventDefault();
      const pkey = projOf.get(cur.dataset.sel);
      focusBtn(pkey === undefined ? null : projEls.get(pkey)?.btn);
    }
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !sorted) return;
  resort();
  paintAll();
});

// ---------- data flow ----------

function announce(prev: SessionRow | undefined, next: SessionRow): void {
  if (next.lifecycle !== "active" || next.attention === "none") return;
  if (prev && prev.attention === next.attention) return;
  setText(announcer, `${ATT[next.attention]}になりました: ${titleOf(next)}（${next.machine_id}）`);
}

function putMachines(list: MachineRow[], authoritative: boolean): void {
  const now = Date.now();
  for (const m of list) {
    machines.set(m.machine_id, m);
    if (authoritative) {
      serverOnline.set(m.machine_id, now - Date.parse(m.last_heartbeat_at) < PERF.machineStaleMs);
    }
  }
}

async function resync(since: number): Promise<void> {
  if (resyncing) return;
  resyncing = true;
  try {
    const response = await fetch(`/api/resync?since=${since}`);
    if (!response.ok) return;
    const data = (await response.json()) as {
      machines: MachineRow[];
      sequence: number;
      sessions: SessionRow[];
    };
    putMachines(data.machines, true);
    for (const s of data.sessions) putSession(s);
    lastSequence = Math.max(lastSequence, data.sequence);
    const sel = selectedId();
    if (sel && data.sessions.some((s) => s.session_id === sel)) void loadEvents(sel);
    paintAll();
  } catch {
    return;
  } finally {
    resyncing = false;
  }
}

let resyncAfterSnapshot: number | null = null;
let snapshotSeen = false;

function handleMessage(data: StreamMessage): void {
  switch (data.type) {
    case "snapshot": {
      putMachines(data.machines, true);
      for (const s of data.sessions) putSession(s);
      lastSequence = data.sequence;
      // The first snapshot is still the initial load and carries more rows than the REST read.
      if (!snapshotSeen) resort();
      snapshotSeen = true;
      if (resyncAfterSnapshot !== null) {
        void resync(resyncAfterSnapshot);
        resyncAfterSnapshot = null;
      }
      paintAll();
      return;
    }
    case "session": {
      const prev = sessions.get(data.session.session_id);
      const since = lastSequence;
      putSession(data.session);
      lastSequence = Math.max(lastSequence, data.sequence);
      announce(prev, data.session);
      paintAll();
      tickMarker(data.session.session_id);
      if (selectedId() === data.session.session_id) void loadEvents(data.session.session_id);
      if (data.sequence > since + 1) void resync(since);
      return;
    }
    case "machine": {
      machines.set(data.machine.machine_id, data.machine);
      serverOnline.set(
        data.machine.machine_id,
        typeof data.online === "boolean"
          ? data.online
          : Date.now() - Date.parse(data.machine.last_heartbeat_at) < LEGACY_NOTICE_ONLINE_MS,
      );
      paintAll();
      return;
    }
    case "thread": {
      const visible = data.thread_id === MUSE_THREAD_ID || selectedId() === data.thread_id;
      if (visible) void loadThread(data.thread_id);
      return;
    }
    default:
      return;
  }
}

function parseMessage(raw: unknown): StreamMessage | null {
  try {
    const data: unknown = JSON.parse(String(raw));
    if (typeof data !== "object" || data === null || !("type" in data)) return null;
    return data as StreamMessage;
  } catch {
    return null;
  }
}

let retryMs: number = PERF.retryBaseMs;
let everLive = false;

function connect(): void {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/api/stream`);
  socket.addEventListener("open", () => {
    retryMs = PERF.retryBaseMs;
    if (everLive) resyncAfterSnapshot = lastSequence;
    everLive = true;
    conn = "live";
    lostAt = null;
    paintAll();
  });
  socket.addEventListener("message", (event) => {
    const data = parseMessage(event.data);
    if (data) handleMessage(data);
  });
  socket.addEventListener("close", () => {
    if (everLive) {
      if (conn !== "lost") lostAt = new Date().toISOString();
      conn = "lost";
    }
    paintAll();
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, PERF.retryMaxMs);
  });
}

async function load(): Promise<void> {
  const demo = new URLSearchParams(location.search).get("demo") === "1" ? "?demo=1" : "";
  try {
    const [sessionResponse, machineResponse] = await Promise.all([
      fetch(`/api/sessions${demo}`),
      fetch(`/api/machines${demo}`),
    ]);
    if (sessionResponse.ok) {
      const data = (await sessionResponse.json()) as { sessions: SessionRow[] };
      for (const s of data.sessions) {
        sessions.set(s.session_id, s);
        lastSequence = Math.max(lastSequence, s.board_seq);
      }
    }
    if (machineResponse.ok) {
      const data = (await machineResponse.json()) as { machines: MachineRow[] };
      putMachines(data.machines, false);
    }
  } catch {
    // The socket snapshot fills the board when the REST read fails.
    return;
  }
}

applyTheme(document.documentElement.dataset.themeChoice ?? "auto");
threadView(MUSE_THREAD_ID);
void loadThread(MUSE_THREAD_ID);
paintAll(true);
void load().then(() => {
  if (!sorted) resort();
  paintAll();
  connect();
});
setInterval(() => paintAll(), 1000);
