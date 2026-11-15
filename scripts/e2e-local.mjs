import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const tmp = mkdtempSync(join(tmpdir(), "agent-board-e2e-"));
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
  const address = server.address();
  const port = address.port;
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
  if (outcome.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${outcome.stdout}\n${outcome.stderr}`);
  }
  return outcome;
}

async function waitForWorker(base) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/sessions`);
      if (response.ok) return;
    } catch {
      // The dev server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("wrangler dev did not become ready");
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
  await waitForWorker(base);
  return base;
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

function hook(payload) {
  run("node", ["dist/src/sender/hook.js"], {
    env: { AGENT_BOARD_HOME: home },
    input: JSON.stringify(payload),
  });
}

function daemon(extraEnv = {}) {
  run("node", ["dist/src/sender/daemon.js", "--once"], {
    env: {
      AGENT_BOARD_HOME: home,
      AGENT_BOARD_RETRY_BASE_MS: "25",
      AGENT_BOARD_RETRY_MAX_ATTEMPTS: "2",
      AGENT_BOARD_RETRY_MAX_MS: "50",
      ...extraEnv,
    },
  });
}

async function getSession(base, id) {
  const response = await fetch(`${base}/api/sessions/${id}`);
  assert(response.ok, `get session ${id} returned ${response.status}`);
  const data = await response.json();
  return data.session;
}

async function mcp(base, method, params = {}) {
  const response = await fetch(`${base}/mcp`, {
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
    headers: { authorization: `Bearer ${mcpToken}`, "content-type": "application/json" },
    method: "POST",
  });
  assert(response.ok, `mcp ${method} returned ${response.status}`);
  return response.json();
}

const stage = (name) => process.stdout.write(`stage ${name}\n`);
const port = await freePort();
let base = "";
const messages = [];
let socket;

try {
  stage("build");
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
    stage("start-worker");
    base = await startWorker(port);
    run("mkdir", ["-p", home]);
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ endpoint: base, machine_id: "machine-a" }),
    );
    writeFileSync(join(home, "token"), machineToken);

    stage("worker-ready");
    const page = await fetch(`${base}/`);
    assert(page.ok, "board page should load");
    const pageText = await page.text();
    assert(pageText.includes("Agent Board"), "board page should contain the title");
    const appJs = await fetch(`${base}/app.js`);
    assert(appJs.ok, "board script should load");
    const demoResponse = await fetch(`${base}/api/sessions?demo=1`);
    const demoData = await demoResponse.json();
    assert(demoData.sessions.length >= 2, "demo mode should return synthetic sessions");
    socket = new WebSocket(`ws://127.0.0.1:${port}/api/stream`);
    socket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data))));
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });

    const fixture = JSON.parse(readFileSync("tests/fixtures/claude-session.json", "utf8"));
    const byName = (name) => fixture.filter((event) => event.hook_event_name === name);

    stage("drive-session-start");
    for (const event of [
      ...byName("SessionStart"),
      ...byName("UserPromptSubmit"),
      ...byName("SubagentStart"),
    ])
      hook(event);
    daemon();
    let session = await getSession(base, "claude-demo-1");
    assert(session.lifecycle === "active", "session should be active");
    assert(session.activity === "running", "session should be running after prompt");
    assert(session.title.includes("Fix the demo parser"), "title should come from first prompt");
    assert(session.subagent_count === 1, "subagent should roll up on the parent");

    stage("drive-permission");
    for (const event of [
      ...byName("SubagentStop"),
      ...byName("PermissionRequest"),
      ...byName("Notification"),
    ])
      hook(event);
    daemon();
    session = await getSession(base, "claude-demo-1");
    assert(session.attention === "needs_approval", "permission should set needs_approval");
    assert(session.subagent_count === 0, "subagent stop should clear the running count");
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert(
      messages.some(
        (message) => message.type === "session" && message.session?.attention === "needs_approval",
      ),
      "websocket should carry the permission row",
    );

    stage("drive-stop");
    for (const event of byName("PostToolUse")) hook(event);
    for (const event of byName("Stop")) hook(event);
    daemon();
    session = await getSession(base, "claude-demo-1");
    assert(session.activity === "idle", "stop should set idle");
    assert(session.attention === "none", "stop should clear attention");

    stage("drive-session-end");
    for (const event of byName("SessionEnd")) hook(event);
    daemon();
    session = await getSession(base, "claude-demo-1");
    assert(session.lifecycle === "ended", "session end should set ended");

    stage("mcp");
    const init = await mcp(base, "initialize", { protocolVersion: "2025-03-26" });
    assert(init.result?.serverInfo?.name === "agent-board", "MCP initialize failed");
    const got = await mcp(base, "tools/call", {
      arguments: { session_id: "claude-demo-1" },
      name: "get_session",
    });
    assert(
      got.result?.structuredContent?.session?.lifecycle === "ended",
      "MCP get_session mismatch",
    );
    const listed = await mcp(base, "tools/call", {
      arguments: { limit: 10 },
      name: "list_sessions",
    });
    assert(listed.result?.structuredContent?.sessions?.length >= 1, "MCP list_sessions empty");

    stage("outage-stop-worker");
    await stopWorker();
    const outagePayloads = [
      { cwd: "/example/demo-repo", hook_event_name: "SessionStart", session_id: "codex-outage-1" },
      {
        hook_event_name: "UserPromptSubmit",
        prompt: "Recover after the outage",
        session_id: "codex-outage-1",
      },
    ];
    for (const event of outagePayloads) hook(event);
    daemon();
    stage("outage-restart-worker");
    base = await startWorker(port);
    daemon();
    const recovered = await getSession(base, "codex-outage-1");
    assert(recovered.activity === "running", "spool replay should converge after restart");
    const eventsResponse = await fetch(`${base}/api/sessions/codex-outage-1/events`);
    const eventsData = await eventsResponse.json();
    assert(
      eventsData.events.length === 2,
      `replay should not duplicate events, got ${eventsData.events.length}`,
    );

    const metricsResponse = await fetch(`${base}/api/metrics`);
    const metrics = (await metricsResponse.json()).metrics;
    process.stdout.write("e2e local passed\n");
    process.stdout.write(`metrics ${JSON.stringify(metrics)}\n`);
    process.stdout.write(`websocket messages ${messages.length}\n`);
  } finally {
    rmSync(join(root, ".dev.vars"), { force: true });
  }
} finally {
  socket?.close();
  await stopWorker();
  rmSync(tmp, { force: true, recursive: true });
}
