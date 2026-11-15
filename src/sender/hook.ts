import { loadConfig, senderHome } from "./config.js";
import { payloadToEnvelope } from "./payload.js";
import { appendEnvelope } from "./spool.js";
import { join } from "node:path";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  try {
    const text = await readStdin();
    if (!text.trim()) return;
    const raw: unknown = JSON.parse(text);
    const envelope = payloadToEnvelope(raw);
    let spoolDir = join(senderHome(), "spool");
    try {
      spoolDir = loadConfig().spoolDir;
    } catch {
      spoolDir = join(senderHome(), "spool");
    }
    appendEnvelope(spoolDir, envelope);
  } catch {
    return;
  }
}

void main().finally(() => {
  process.exitCode = 0;
});
