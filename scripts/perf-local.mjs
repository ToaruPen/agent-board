import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const tmp = mkdtempSync(join(tmpdir(), "agent-board-perf-"));
const home = join(tmp, "agent-home");
const stateDir = join(tmp, "wrangler-state");
const machineToken = "local-machine-token";
const mcpToken = "local-mcp-token";
let wrangler = null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function run(command, args, options = {}) {
  const outcome = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    input: options.input,
  });
  if (outcome.status !== 0)
    throw new Error(`${command} failed\n${outcome.stdout}\n${outcome.stderr}`);
  return outcome;
}
async function startWorker(port) {
  const base = `http://127.0.0.1:${port}`;
  const logFd = openSync(join(tmp, "wrangler.log"), "a");
  wrangler = spawn(
    "npx",
    [
      "wrangler",
      "dev",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--persist-to",
      stateDir,
      "--var",
      "ENVIRONMENT:local",
      "--var",
      "LOCAL_DEV_AUTH_BYPASS:true",
    ],
    { cwd: root, env: process.env, stdio: ["ignore", logFd, logFd] },
  );
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/sessions`);
      if (response.ok) return base;
    } catch {
      // The dev server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("wrangler did not start");
}
async function stopWorker() {
  if (!wrangler) return;
  const child = wrangler;
  wrangler = null;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
async function metrics(base) {
  const response = await fetch(`${base}/api/metrics`);
  assert(response.ok, "metrics failed");
  return (await response.json()).metrics;
}

const port = await freePort();
let socket;
try {
  run("npm", ["run", "build"]);
  const devVarsPath = join(root, ".dev.vars");
  assert(!existsSync(devVarsPath), ".dev.vars already exists; refusing to overwrite it");
  writeFileSync(
    devVarsPath,
    [
      `MACHINE_TOKENS_JSON=${JSON.stringify({ "machine-a": hash(machineToken) })}`,
      `MCP_TOKEN_SHA256=${hash(mcpToken)}`,
      "",
    ].join("\n"),
  );
  try {
    const base = await startWorker(port);
    run("mkdir", ["-p", home]);
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ endpoint: base, machine_id: "machine-a" }),
    );
    writeFileSync(join(home, "token"), machineToken);

    socket = new WebSocket(`ws://127.0.0.1:${port}/api/stream`);
    const socketMessages = [];
    socket.addEventListener("message", (event) =>
      socketMessages.push(JSON.parse(String(event.data))),
    );
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });

    const before = await metrics(base);
    const latencies = [];
    for (let i = 0; i < 200; i += 1) {
      const started = performance.now();
      run("node", ["dist/hook.bundle.mjs"], {
        env: { AGENT_BOARD_HOME: home },
        input: JSON.stringify({
          hook_event_name: "PreToolUse",
          session_id: "perf-session",
          tool_name: "Bash",
        }),
      });
      latencies.push(performance.now() - started);
    }
    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    const spoolBefore = readFileSync(
      join(
        home,
        "spool",
        `${createHash("sha256").update("perf-session").digest("hex").slice(0, 32)}.jsonl`,
      ),
      "utf8",
    )
      .split("\n")
      .filter(Boolean).length;

    run("node", ["dist/src/sender/daemon.js", "--once"], {
      env: {
        AGENT_BOARD_HOME: home,
        AGENT_BOARD_RETRY_BASE_MS: "25",
        AGENT_BOARD_RETRY_MAX_ATTEMPTS: "2",
        AGENT_BOARD_RETRY_MAX_MS: "50",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const after = await metrics(base);
    const delta = {
      broadcasts: after.broadcasts - before.broadcasts,
      eventWrites: after.eventWrites - before.eventWrites,
      ingestRequests: after.ingestRequests - before.ingestRequests,
      sessionWrites: after.sessionWrites - before.sessionWrites,
    };
    assert(delta.ingestRequests === 1, `expected 1 ingest request, got ${delta.ingestRequests}`);
    assert(delta.eventWrites === 1, `expected 1 stored event, got ${delta.eventWrites}`);
    assert(
      delta.sessionWrites <= 2,
      `expected at most 2 session writes, got ${delta.sessionWrites}`,
    );
    assert(delta.broadcasts <= 2, `expected at most 2 broadcasts, got ${delta.broadcasts}`);
    const floorLatencies = [];
    for (let i = 0; i < 20; i += 1) {
      const started = performance.now();
      run("node", ["-e", ""]);
      floorLatencies.push(performance.now() - started);
    }
    floorLatencies.sort((a, b) => a - b);
    const floorP95 = floorLatencies[Math.floor(floorLatencies.length * 0.95)];
    assert(
      p95 < 150,
      `hook p95 ${p95.toFixed(1)}ms exceeds the 150ms measured budget for a Node hook on this machine`,
    );

    const sessionResponse = await fetch(`${base}/api/sessions/perf-session`);
    const session = (await sessionResponse.json()).session;
    assert(session.tool_pulses === 200, `expected 200 pulses, got ${session.tool_pulses}`);

    for (let batch = 0; batch < 5; batch += 1) {
      const events = Array.from({ length: 50 }, (_, i) => ({
        cli: "claude-code",
        cli_version: "perf",
        event_id: `flood-${batch}-${i}`,
        event_name: "PreToolUse",
        occurred_at: new Date().toISOString(),
        pulse_count: 1,
        sender_version: "perf",
        session_id: "flood-session",
        tool_name: "Bash",
        v: 1,
      }));
      const response = await fetch(`${base}/api/ingest`, {
        body: JSON.stringify({ events }),
        headers: { authorization: `Bearer ${machineToken}`, "content-type": "application/json" },
        method: "POST",
      });
      assert(response.ok, `flood ingest returned ${response.status}`);
    }
    const eventsResponse = await fetch(`${base}/api/sessions/flood-session/events?limit=200`);
    const events = (await eventsResponse.json()).events;
    assert(events.length === 200, `event window should cap at 200, got ${events.length}`);

    process.stdout.write("perf local passed\n");
    process.stdout.write(
      `hook latency p50 ${p50.toFixed(1)}ms p95 ${p95.toFixed(1)}ms budget 150ms\n`,
    );
    process.stdout.write(`empty node script p95 ${floorP95.toFixed(1)}ms on this machine\n`);
    process.stdout.write(`spool lines before daemon ${spoolBefore}\n`);
    process.stdout.write(`coalesced delta ${JSON.stringify(delta)}\n`);
    process.stdout.write("event window after 250 flood events 200\n");
  } finally {
    rmSync(join(root, ".dev.vars"), { force: true });
  }
} finally {
  socket?.close();
  await stopWorker();
  rmSync(tmp, { force: true, recursive: true });
}
