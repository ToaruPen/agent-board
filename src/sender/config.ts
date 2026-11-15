import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PERF } from "../shared/perf.js";

export const SENDER_PERF = PERF;

export interface SenderConfig {
  configPath: string;
  dialogueEnabled: boolean;
  endpoint: string;
  home: string;
  machineId: string;
  spoolDir: string;
  statePath: string;
  tokenPath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function senderHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_BOARD_HOME ?? join(homedir(), ".agent-board");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SenderConfig {
  const home = senderHome(env);
  const configPath = join(home, "config.json");
  if (!existsSync(configPath)) throw new Error(`missing config at ${configPath}`);
  const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  if (!isRecord(parsed)) throw new Error("config must be an object");
  const endpoint = parsed.endpoint;
  const machineId = parsed.machine_id;
  if (typeof endpoint !== "string" || typeof machineId !== "string") {
    throw new Error("config requires endpoint and machine_id strings");
  }
  if ("token" in parsed || "api_key" in parsed) {
    throw new Error("config must not contain a token");
  }
  return {
    configPath,
    dialogueEnabled: parsed.dialogue_enabled !== false,
    endpoint: endpoint.replace(/\/$/, ""),
    home,
    machineId,
    spoolDir: join(home, "spool"),
    statePath: join(home, "state.json"),
    tokenPath: join(home, "token"),
  };
}

export function loadToken(config: SenderConfig): string {
  if (!existsSync(config.tokenPath)) throw new Error(`missing token at ${config.tokenPath}`);
  const token = readFileSync(config.tokenPath, "utf8").trim();
  if (!token) throw new Error("token file is empty");
  return token;
}
