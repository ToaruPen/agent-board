import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { EventEnvelope } from "../shared/envelope.js";
import { newEventId } from "../shared/ids.js";
import { PERF } from "../shared/perf.js";
import { isStateChanging } from "../shared/normalizer.js";
import { SENDER_VERSION } from "./payload.js";

export interface SpoolCaps {
  maxBytes: number;
  maxFileBytes: number;
  maxFiles: number;
}

export const DEFAULT_SPOOL_CAPS: SpoolCaps = {
  maxBytes: PERF.spoolMaxBytes,
  maxFileBytes: PERF.spoolMaxFileBytes,
  maxFiles: PERF.spoolMaxFiles,
};

export interface AppendResult {
  droppedToolEvents: number;
  path: string | null;
  spooled: boolean;
}

function hashName(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
}

export function spoolPath(spoolDir: string, sessionId: string, part = 0): string {
  const suffix = part === 0 ? "" : `-${part + 1}`;
  return join(spoolDir, `${hashName(sessionId)}${suffix}.jsonl`);
}

export function listSpoolFiles(spoolDir: string): string[] {
  if (!existsSync(spoolDir)) return [];
  return readdirSync(spoolDir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .map((name) => join(spoolDir, name));
}

export function spoolStats(spoolDir: string): { bytes: number; files: number; lines: number } {
  let bytes = 0;
  let lines = 0;
  const files = listSpoolFiles(spoolDir);
  for (const file of files) {
    bytes += statSync(file).size;
    const text = readFileSync(file, "utf8");
    lines += text ? text.split("\n").filter(Boolean).length : 0;
  }
  return { bytes, files: files.length, lines };
}

function isToolLine(line: string): boolean {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) return false;
    const name = (parsed as Record<string, unknown>).event_name;
    return name === "PreToolUse" || name === "PostToolUse";
  } catch {
    return false;
  }
}

function pruneLines(spoolDir: string, needed: number, toolOnly: boolean): number {
  let freed = 0;
  let dropped = 0;
  const files = listSpoolFiles(spoolDir)
    .map((path) => ({ mtime: statSync(path).mtimeMs, path }))
    .sort((a, b) => a.mtime - b.mtime);
  for (const { path } of files) {
    if (freed >= needed) break;
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    const kept: string[] = [];
    for (const line of lines) {
      const removable = toolOnly ? isToolLine(line) : !line.includes("SpoolDropped");
      if (freed < needed && removable) {
        freed += Buffer.byteLength(line) + 1;
        if (isToolLine(line)) dropped += 1;
      } else {
        kept.push(line);
      }
    }
    if (kept.length === 0) rmSync(path);
    else writeFileSync(path, `${kept.join("\n")}\n`);
  }
  return dropped;
}

function choosePath(
  spoolDir: string,
  sessionId: string,
  lineBytes: number,
  caps: SpoolCaps,
): string | null {
  for (let part = 0; part < caps.maxFiles; part += 1) {
    const path = spoolPath(spoolDir, sessionId, part);
    if (!existsSync(path)) {
      return listSpoolFiles(spoolDir).length < caps.maxFiles ? path : null;
    }
    if (statSync(path).size + lineBytes <= caps.maxFileBytes) return path;
  }
  return null;
}

export function appendEnvelope(
  spoolDir: string,
  envelope: EventEnvelope,
  caps: SpoolCaps = DEFAULT_SPOOL_CAPS,
): AppendResult {
  mkdirSync(spoolDir, { recursive: true });
  const line = `${JSON.stringify(envelope)}\n`;
  const lineBytes = Buffer.byteLength(line);
  if (lineBytes > caps.maxFileBytes) return { droppedToolEvents: 0, path: null, spooled: false };
  let dropped = 0;
  let stats = spoolStats(spoolDir);
  if (stats.bytes + lineBytes > caps.maxBytes || stats.files >= caps.maxFiles) {
    dropped += pruneLines(spoolDir, stats.bytes + lineBytes - caps.maxBytes + 1024, true);
    stats = spoolStats(spoolDir);
    if (stats.bytes + lineBytes > caps.maxBytes) {
      pruneLines(spoolDir, stats.bytes + lineBytes - caps.maxBytes + 1024, false);
    }
  }
  const path = choosePath(spoolDir, envelope.session_id, lineBytes, caps);
  if (!path) {
    return { droppedToolEvents: dropped, path: null, spooled: false };
  }
  appendFileSync(path, line);
  if (dropped > 0) {
    const marker: EventEnvelope = {
      cli: envelope.cli,
      cli_version: envelope.cli_version,
      dropped_tool_events: dropped,
      event_id: newEventId(),
      event_name: "SpoolDropped",
      occurred_at: new Date().toISOString(),
      sender_version: SENDER_VERSION,
      session_id: envelope.session_id,
      v: 1,
    };
    const markerLine = `${JSON.stringify(marker)}\n`;
    const markerPath = choosePath(
      spoolDir,
      envelope.session_id,
      Buffer.byteLength(markerLine),
      caps,
    );
    if (markerPath && spoolStats(spoolDir).bytes + Buffer.byteLength(markerLine) <= caps.maxBytes) {
      appendFileSync(markerPath, markerLine);
    }
  }
  return { droppedToolEvents: dropped, path, spooled: true };
}

export function claimSpoolFile(path: string): string {
  const claimed = `${path}.claim-${process.pid}-${Date.now()}`;
  renameSync(path, claimed);
  return claimed;
}

export function listClaimFiles(spoolDir: string): string[] {
  if (!existsSync(spoolDir)) return [];
  return readdirSync(spoolDir)
    .filter((name) => name.includes(".claim-"))
    .sort()
    .map((name) => join(spoolDir, name));
}

export function appendDeadLetter(home: string, lines: string[], reason: string): void {
  mkdirSync(home, { recursive: true });
  const path = join(home, "dead-letter.jsonl");
  const payload = lines
    .map((line) => JSON.stringify({ at: new Date().toISOString(), line, reason }))
    .join("\n");
  appendFileSync(path, `${payload}\n`);
  if (statSync(path).size > PERF.spoolMaxBytes / 2) {
    const text = readFileSync(path, "utf8").split("\n").filter(Boolean);
    const kept: string[] = [];
    let size = 0;
    for (let i = text.length - 1; i >= 0; i -= 1) {
      const line = text[i] as string;
      size += Buffer.byteLength(line) + 1;
      if (size > PERF.spoolMaxBytes / 2) break;
      kept.unshift(line);
    }
    writeFileSync(path, kept.length ? `${kept.join("\n")}\n` : "");
  }
}

export function isToolPulse(envelope: EventEnvelope): boolean {
  return (
    !isStateChanging(envelope.event_name) &&
    (envelope.event_name === "PreToolUse" || envelope.event_name === "PostToolUse")
  );
}
