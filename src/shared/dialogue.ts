import type { CliKind } from "./envelope.js";

export const MUSE_THREAD_ID = "muse";

export type DialogueAuthor = "agent" | "muse" | "pen";

export type DialogueStatus =
  | "answered"
  | "delivered"
  | "expired"
  | "failed"
  | "held_busy"
  | "queued"
  | "running";

export const TERMINAL_STATUSES: readonly DialogueStatus[] = ["answered", "expired", "failed"];

export interface DialogueMessage {
  author: DialogueAuthor;
  body: string;
  created_at: string;
  expires_at: string;
  // The session board_seq at the moment the command was last held busy.
  last_offer_seq?: number | null;
  machine_id: string | null;
  message_id: string;
  reason: string | null;
  reply_to: string | null;
  session_id: string | null;
  status: DialogueStatus;
  thread_id: string;
  updated_at: string;
}

export interface AuditEntry {
  action: string;
  actor: string;
  at: string;
  audit_id: number;
  detail: string | null;
  message_id: string;
}

export interface PendingCommand {
  body: string;
  cli: CliKind;
  cwd: string;
  message_id: string;
  session_id: string;
}

export type CommandResultStatus = "answered" | "failed" | "held_busy" | "running";

export interface CommandResult {
  reason?: string;
  reply?: string;
  status: CommandResultStatus;
}
