import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { PendingCommand } from "../shared/dialogue.js";
import type { Activity, EventEnvelope, Lifecycle } from "../shared/envelope.js";
import { PERF } from "../shared/perf.js";

interface SessionActivity {
  activity: Activity;
  lifecycle: Lifecycle;
}

const TRACKER_CAP = 1_000;
const RUNNING_EVENTS = new Set([
  "Notification",
  "PermissionDenied",
  "PermissionRequest",
  "PostToolUse",
  "PreToolUse",
]);

function nextActivity(
  prior: SessionActivity | undefined,
  eventName: string,
): SessionActivity | null {
  if (eventName === "SessionStart") return { activity: "idle", lifecycle: "active" };
  if (eventName === "UserPromptSubmit") return { activity: "running", lifecycle: "active" };
  if (eventName === "StopFailure") return { activity: "idle", lifecycle: "failed" };
  if (eventName === "SessionEnd") return { activity: "idle", lifecycle: "ended" };
  if (RUNNING_EVENTS.has(eventName)) {
    return { activity: "running", lifecycle: prior?.lifecycle ?? "active" };
  }
  if (eventName === "Stop") return { activity: "idle", lifecycle: prior?.lifecycle ?? "active" };
  return null;
}

function isActivity(value: unknown): value is Activity {
  return value === "running" || value === "idle" || value === "unknown";
}

function isLifecycle(value: unknown): value is Lifecycle {
  return value === "active" || value === "ended" || value === "failed";
}

export class SessionActivityTracker {
  private readonly sessions = new Map<string, SessionActivity>();

  // Returns true when the tracked state changed, so the caller persists only on change.
  observe(envelope: EventEnvelope): boolean {
    const prior = this.sessions.get(envelope.session_id);
    const next = nextActivity(prior, envelope.event_name);
    if (!next) return false;
    this.sessions.delete(envelope.session_id);
    this.sessions.set(envelope.session_id, next);
    if (this.sessions.size > TRACKER_CAP) {
      const oldest = this.sessions.keys().next().value;
      if (oldest !== undefined) this.sessions.delete(oldest);
    }
    return prior?.activity !== next.activity || prior?.lifecycle !== next.lifecycle;
  }

  isSafe(sessionId: string): boolean | null {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    return state.lifecycle !== "active" || state.activity === "idle";
  }

  toJSON(): Record<string, SessionActivity> {
    return Object.fromEntries(this.sessions);
  }

  static fromJSON(value: unknown): SessionActivityTracker {
    const tracker = new SessionActivityTracker();
    if (typeof value !== "object" || value === null) return tracker;
    for (const [sessionId, raw] of Object.entries(value)) {
      if (typeof raw !== "object" || raw === null) continue;
      const { activity, lifecycle } = raw as Record<string, unknown>;
      if (isActivity(activity) && isLifecycle(lifecycle)) {
        tracker.sessions.set(sessionId, { activity, lifecycle });
      }
    }
    return tracker;
  }
}

export interface CliRunResult {
  code: number | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

export type CliRunner = (
  bin: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<CliRunResult>;

export interface ExecutionOutcome {
  reason?: string;
  reply?: string;
  status: "answered" | "failed" | "held_busy";
}

const CAPTURE_MAX_BYTES = 262_144;
const KILL_GRACE_MS = 5_000;
const REASON_LIMIT = 200;
const WRITER_LOCK_MARKERS = ["already has an active writer", "thread-store"];

class Capture {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;

  push(chunk: Buffer): void {
    const room = CAPTURE_MAX_BYTES - this.bytes;
    if (room <= 0) return;
    const kept = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
    this.chunks.push(kept);
    this.bytes += kept.byteLength;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

const defaultRunner: CliRunner = (bin, args, options) =>
  new Promise((resolve) => {
    const stdout = new Capture();
    const stderr = new Capture();
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const child = spawn(bin, args, {
      cwd: options.cwd,
      env: { ...process.env, AGENT_BOARD_DIALOGUE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    }, options.timeoutMs);
    const finish = (code: number | null, extraError = "") => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        code,
        stderr: `${stderr.text()}${extraError}`,
        stdout: stdout.text(),
        timedOut,
      });
    };
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => finish(null, String(error)));
    child.once("close", (code) => finish(code));
  });

function writerLockLine(output: string): string | null {
  const line = output
    .split("\n")
    .find((candidate) => WRITER_LOCK_MARKERS.some((marker) => candidate.includes(marker)));
  return line === undefined ? null : line.trim().slice(0, REASON_LIMIT);
}

export async function executeCommand(
  command: PendingCommand,
  options: { claudeBin?: string; codexBin?: string; run?: CliRunner; timeoutMs?: number } = {},
): Promise<ExecutionOutcome> {
  const claudeBin = options.claudeBin ?? process.env.AGENT_BOARD_CLAUDE_BIN ?? "claude";
  const codexBin = options.codexBin ?? process.env.AGENT_BOARD_CODEX_BIN ?? "codex";
  const [bin, args] =
    command.cli === "codex"
      ? [codexBin, ["exec", "--skip-git-repo-check", "resume", command.session_id, command.body]]
      : [claudeBin, ["--resume", command.session_id, "-p", command.body]];
  const cwd = command.cwd && existsSync(command.cwd) ? command.cwd : homedir();
  const result = await (options.run ?? defaultRunner)(bin, args, {
    cwd,
    timeoutMs: options.timeoutMs ?? PERF.dialogueExecTimeoutMs,
  });
  const lock = writerLockLine(`${result.stdout}\n${result.stderr}`);
  if (lock !== null) return { reason: lock, status: "held_busy" };
  if (result.timedOut) return { reason: "timeout", status: "failed" };
  const reply = result.stdout.trim();
  if (result.code === 0 && reply) return { reply, status: "answered" };
  if (result.code === 0) return { reason: "empty_reply", status: "failed" };
  const tail = (result.stderr.trim() || result.stdout.trim()).slice(-REASON_LIMIT).trim();
  return { reason: tail || `exit_${result.code ?? "unknown"}`, status: "failed" };
}
