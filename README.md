# Agent Board

Agent Board is a live board for coding agent sessions. It collects session events from Claude Code and Codex running on several machines. It shows which session is working, which session is waiting for a person, and which session has ended. Agents can query the same state through MCP tools.

## What it does

- Collects hook events from Claude Code and Codex through one small sender per machine.
- Stores live session state in one Cloudflare Durable Object.
- Pushes changes to an open board page over WebSocket. A page shows seconds since the last event for each session.
- Shows subagents as a count on the parent session card, with a drill in list.
- Answers agent queries through read only MCP tools named `list_sessions`, `get_session`, and `get_recent_events`.
- Keeps working after a network outage. The sender spools events on disk and the daemon replays them. The server deduplicates by event id.

## What it does not do

- It does not start, stop, or control sessions.
- It does not assign tasks.
- It does not read or upload transcripts.
- It does not guarantee capture. Hooks are best effort and a user can disable them.
- It is not a trace or cost analytics platform.

## Architecture

```text
Each machine                          Cloudflare
+-----------------------+             +-------------------------------+
| Claude Code hooks     |             | One Worker                    |
| Codex hooks           |  HTTPS      |  POST /api/ingest             |
|        |              +-----------> |  GET  /api/sessions           |
| hook shim appends to  |  per        |  GET  /api/sessions/:id       |
| a spool file          |  machine    |  WS   /api/stream             |
|        |              |  token    |  POST /mcp                    |
| daemon flushes spool  +-----------> |        |                      |
| daemon sends heartbeat|             | Board Durable Object          |
+-----------------------+             |  SQLite live store            |
                                      |  monotonic board sequence     |
People open the board page            +-------------------------------+
Agents query the MCP endpoint
```

State has four dimensions. Lifecycle is active, ended, or failed. Activity is running, idle, or unknown. Attention is a flag for needs approval, needs input, or elicitation, with the event that set it. Actors are the parent session and its subagents.

## Quickstart on your own Cloudflare account

You need a Cloudflare account, Node 22 or later, and `just`.

1. Clone this repo and run `npm install`.
2. Replace every `REPLACE_ME` placeholder in `wrangler.toml` with your own values in your private deployment copy. The committed file carries placeholders only.
3. Create the board with `npx wrangler deploy` after `npx wrangler login`, or use the deploy workflow described in `docs/deployment.md`.
4. Put a Cloudflare Access application in front of the board hostname. Keep the hostname out of public material.
5. Add one ingest token per machine. The Worker stores a hash only. See `SECURITY.md` for issue and rotation steps.
6. Add one MCP bearer token for agent clients.
7. On each machine, create `~/.agent-board/config.json` from `config.example.json`. Put the machine token in `~/.agent-board/token` with mode 600. The config file holds no token.
8. Install the hook snippets below and run `just doctor` on that machine.

## Hook setup

Claude Code reads `~/.claude/settings.json`. Add a command hook for each event that runs the installed shim.

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "~/.agent-board/bin/send" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "~/.agent-board/bin/send" }] }],
    "PreToolUse": [{ "hooks": [{ "type": "command", "command": "~/.agent-board/bin/send" }] }],
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "~/.agent-board/bin/send" }] }],
    "PermissionRequest": [{ "hooks": [{ "type": "command", "command": "~/.agent-board/bin/send" }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "~/.agent-board/bin/send" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "~/.agent-board/bin/send" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "~/.agent-board/bin/send" }] }]
  }
}
```

Codex reads `~/.codex/hooks.json` with the same event names and the same shim command. Codex asks for a trust review of new or changed hooks. Review the shim once and keep the command string stable. Templates live in `docs/hooks/claude-settings.example.json` and `docs/hooks/codex-hooks.example.json`.

The shim appends one line to a spool file and exits. A daemon flushes the spool and sends a heartbeat. Run the daemon under launchd, systemd, or a Windows service on each machine.

## MCP usage

Point an MCP client at the board endpoint with its own bearer token.

```text
POST https://REPLACE_ME.example.com/mcp
Authorization: Bearer REPLACE_ME
```

Tools are read only.

- `list_sessions` returns current session rows. It accepts an optional machine filter.
- `get_session` returns one session by id, with its subagent rollup.
- `get_recent_events` returns recent events for one session, newest last.

## Security model

Three auth planes stay separate.

- People reach the board page and the read API through Cloudflare Access.
- Machines send events with a per machine token. The Worker stores a hash and derives the machine from the token. A leaked token can only forge its own machine. Each token can be revoked on its own.
- Agents query MCP with a separate bearer token checked in the Worker.

Secrets never enter this repo. `just check` runs secretlint over the whole tree and a canary test that proves a planted dummy secret fails the check. See `SECURITY.md`.

## Privacy

What leaves a machine:

- The event name, the session id, the agent kind, and the working directory name from each hook payload.
- The first prompt, truncated, used as the session title.
- Each later prompt and the last assistant message, truncated to the limit in `src/shared/limits.ts`.
- Tool names and tool pulse counts. Tool arguments and tool results do not leave the machine.
- A heartbeat with the machine id, the sender version, and the spool depth.

What never leaves a machine:

- Transcripts.
- File contents.
- Tool arguments and tool results.
- Tokens, other than the machine token sent in a request header to the board endpoint itself.
- Environment variables.

Stored data sits in the hub behind Cloudflare Access. It never enters this public repo. Retention defaults are 7 days for events and 30 days for ended sessions. Both values are configurable in `wrangler.toml`.

## Limitations

- Hook capture is best effort. A CLI update, a disabled hook, or a killed process can drop an event.
- Codex subagents reuse the parent session id. The board rolls them into the parent card and cannot always separate them.
- The Windows Codex app may not fire file based hooks. This repo ships an isolated transcript watcher interface for that case. See `docs/deployment.md`.
- Machine clocks can skew. The server receive time is the ordering truth.
- The board shows the last known state. A silent machine may be offline or may have a broken sender. The heartbeat row separates those cases, and a stale heartbeat marks the machine offline.

## Performance and cost

Cost stays bounded by design. The spool has byte, file count, and per file caps. The daemon coalesces tool pulses over a 3 second window and sends batches of up to 50 events. The Durable Object writes a session row once per changed session per batch, throttles last seen writes to one per 30 seconds, and keeps at most 200 events per session and 10,000 events in total. WebSocket updates go out only for changed rows. Heartbeats run every 60 seconds and write at most once per 30 seconds per machine. Retries back off up to a 30 second cap and dead letter after 5 attempts. Every cap lives in `src/shared/perf.ts`. The full budget table and cost model are in `docs/performance.md`. Run `just perf` for the measured local proof.

## Development

- `just check` runs format check, lint, typecheck, knip, ast-grep with rule tests, secretlint with its canary, and unit tests.
- `just e2e` runs the Worker locally and drives it with the real sender and daemon using synthesized fixtures.
- `just doctor` reports hook presence, spool depth, sender version, last successful post, and config location on one machine.

## Roadmap

- Per machine rollout guides for macOS and Windows services.
- Optional reconciliation against local session listings.
- Alerts after the attention flag has a proven track record.

## License

MIT. See `LICENSE`.
