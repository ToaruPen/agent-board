# Agent Board

## Why

People run Claude Code and Codex sessions directly on several machines. No single place shows which session is running, waiting, or finished. This project aggregates those sessions into one live board that people and agents can read.

## What

- `src/shared/` holds the event envelope, the state model, and the normalizer. It has no platform dependencies.
- `src/sender/` holds the hook entry point, the spool, the daemon, and the doctor command. It runs on each machine.
- `src/worker/` holds one Cloudflare Worker, one Board Durable Object, the read API, the board page, and the MCP endpoint.
- `tests/` holds unit tests, contract tests, and synthesized golden fixtures.
- `demo/` holds synthetic seed data only.

## How

- Install dependencies with `npm install`.
- Run every gate with `just check`.
- Run the local end to end check with `just e2e`.
- Run the Worker locally with `just dev`.

## Facts

- This repo is public. It contains no real hostname, account id, token, machine inventory, or captured payload.
- Per machine configuration lives outside the repo under `~/.agent-board/`. The config file holds a machine id and an endpoint. The token lives in a separate file in the same directory.
- Transcripts never leave a machine. The sender reads hook payloads only.
- Prompts are truncated before storage. The first prompt becomes the session title. The documented limit is in `src/shared/limits.ts`.
- The Board Durable Object is the only live store. There is no second live write path.
- Hook delivery is best effort. The spool and the daemon make delivery converge after an outage.
- Style and lint rules live in Biome, ast-grep, and secretlint configuration. This file does not restate them.

## Invariants

- No secret is committed. A planted secret must fail `just check`. See `SECURITY.md`.
- Machine identity on the server comes from the ingest token. A machine field in a request body is never trusted.
- Changes to any `AGENTS.md` file need human review. These files are a prompt injection surface in a public repo.
- Real captured hook payloads are never used as fixtures. Fixtures are synthesized.
- The board is an observability tool. It is not a control plane.

## Scoped guidance

- Sender work: `src/sender/AGENTS.md`.
- Worker work: `src/worker/AGENTS.md`.
