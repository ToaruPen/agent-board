import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../shared/logger.js";
import { loadConfig, senderHome } from "./config.js";
import { SENDER_VERSION } from "./payload.js";
import { spoolStats } from "./spool.js";

export interface DoctorReport {
  claude_hook_present: boolean | null;
  codex_hook_present: boolean | null;
  config_location: string;
  config_present: boolean;
  last_successful_post_at: string | null;
  sender_version: string;
  spool_bytes: number;
  spool_depth: number;
  spool_files: number;
  token_present: boolean;
}

function hookPresent(path: string): boolean | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8").includes("agent-board");
  } catch {
    return null;
  }
}

export function doctorReport(env: NodeJS.ProcessEnv = process.env): DoctorReport {
  const home = senderHome(env);
  const userHome = env.HOME ?? homedir();
  let configPresent = false;
  let spoolDir = join(home, "spool");
  let statePath = join(home, "state.json");
  try {
    const config = loadConfig(env);
    configPresent = true;
    spoolDir = config.spoolDir;
    statePath = config.statePath;
  } catch {
    configPresent = existsSync(join(home, "config.json"));
  }
  let lastSuccess: string | null = null;
  if (existsSync(statePath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(statePath, "utf8"));
      if (typeof parsed === "object" && parsed !== null) {
        const value = (parsed as Record<string, unknown>).last_successful_post_at;
        lastSuccess = typeof value === "string" ? value : null;
      }
    } catch {
      lastSuccess = null;
    }
  }
  const stats = spoolStats(spoolDir);
  return {
    claude_hook_present: hookPresent(join(userHome, ".claude", "settings.json")),
    codex_hook_present: hookPresent(join(userHome, ".codex", "hooks.json")),
    config_location: join(home, "config.json"),
    config_present: configPresent,
    last_successful_post_at: lastSuccess,
    sender_version: SENDER_VERSION,
    spool_bytes: stats.bytes,
    spool_depth: stats.lines,
    spool_files: stats.files,
    token_present: existsSync(join(home, "token")),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = doctorReport();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.config_present) log("warn", "agent board config is missing");
}
