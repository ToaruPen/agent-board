# Deployment

This document lists the operator steps that remain outside the repo. No step here has been run by the build. No real token, account id, or hostname belongs in this repo.

## Operator steps

1. Sign in to Cloudflare on the operator machine with `npx wrangler login`. The alternative is a scoped API token with Workers Scripts edit access for one account only. Store it in the operator password manager or in GitHub Secrets. Never commit it.
2. Copy the placeholder values in `wrangler.toml` to your account values in your private deployment copy. Set the real account id there or through the `CLOUDFLARE_ACCOUNT_ID` environment variable at deploy time.
3. Create the Access application for the board hostname. The application covers the board page and the read API paths. Add an Allow policy for the operator identity only. Note the team domain and the application audience value. Put them in the Worker vars named `ACCESS_ISSUER` and `ACCESS_AUD` through the Cloudflare dashboard or a private vars file. Keep the hostname out of public material.
4. Create one ingest token per machine. Hash each token with SHA 256. Put the machine id to hash map in the Worker secret named `MACHINE_TOKENS_JSON`. Put each plain token only in that machine file `~/.agent-board/token`.
5. Create one MCP token. Put its SHA 256 hash in the Worker secret named `MCP_TOKEN_SHA256`. Put the plain token only in MCP client configuration.
6. Deploy once from the operator machine with `just deploy`. Confirm the board loads behind Access and that an unauthenticated request is rejected.
7. Create the GitHub repo as public. Turn on secret scanning and push protection before the first push. Add branch protection on `main` that requires the check workflow.
8. Add GitHub Secrets for CI deploy. One pipeline, `.github/workflows/ci-cd.yml`, runs the check matrix first and deploys only when it passes, only from `main`, from `v*` tags, or by manual dispatch. It needs a scoped Cloudflare token (`CLOUDFLARE_API_TOKEN`) and the account id (`CLOUDFLARE_ACCOUNT_ID`) as secrets. Until both exist, the deploy job ends after a cheap preflight step with a warning and a skipped notice, so the pipeline stays green and spends no install time.
9. Run the auth spike with real clients before rollout. Connect Claude Code, Codex, and one more MCP client to the real `/mcp` endpoint. Confirm each one can list tools and call `list_sessions`. Record the result outside the public repo if it contains the real hostname.

## Per machine rollout

Order: VM first, then Mac mini, then MacBook Pro, then Windows.

For each machine:

1. Install Node 22 or later and this repo build under `~/.agent-board/app`.
2. Build with `npm install` and `npm run build`.
3. Install the shim at `~/.agent-board/bin/send` from `docs/hooks/send.example.sh` or `docs/hooks/send.example.ps1`. Keep the command string stable after this step.
4. Create `~/.agent-board/config.json` from `config.example.json` with that machine id and the board endpoint.
5. Create `~/.agent-board/token` with that machine token. Set mode 600 on macOS and Linux. Set a current user only ACL on Windows. Keep the directory out of synced folders.
6. Merge the hook template into `~/.claude/settings.json` and `~/.codex/hooks.json`. Templates are in `docs/hooks/`. Do not replace existing settings. Merge the `hooks` keys only.
7. Approve the Codex hook trust review on that machine.
8. Run the daemon under launchd, systemd, or a Windows service. The daemon command is `node ~/.agent-board/app/dist/src/sender/daemon.js`.
9. Run `just doctor` from the repo checkout on that machine. Confirm config present, token present, spool depth sane, and a last successful post after one real session.
10. Open one real session and confirm the board shows it within seconds. Trigger one permission prompt and confirm the attention flag appears.

## Dialogue

The board is also a control surface. The operator can post a message to any session thread, or to a dedicated thread addressed to the operator's own assistant. This section is the operator contract for that surface.

How delivery works:

- A message posted in the board UI is stored in the Board Durable Object with the status `queued`. Its full lifecycle is `queued`, `delivered`, `running`, then `answered`, `held_busy`, `failed`, or `expired`. A command expires 24 hours after it was posted.
- No new channel exists. Pending commands for a machine ride the response of that machine's existing 60 second heartbeat. The daemon executes a command only when the session is safe: its lifecycle has ended or failed, or its activity is idle. A session in the middle of a turn is never interrupted. The daemon reports `held_busy` and the Worker offers the command again on a later heartbeat, when the session state changes or after a fallback delay, until the command expires.
- Execution is one resume turn on the machine. Claude Code runs `claude --resume <session_id> -p <message>`. Codex runs `codex exec --skip-git-repo-check resume <session_id> <message>` with stdin closed. A refusal that names a writer lock (the Codex app holding its own thread) is reported as `held_busy` with the reason, not as a failure. Execution is capped at 15 minutes. The final assistant text returns as the thread reply, truncated to the same limit as other stored messages.
- Every state change writes an audit row in the Durable Object with the actor, the action, and the time. There is no silent path from a posted message to a running command.
- One command per session is in flight at a time.

Operator steps for dialogue:

1. Per machine opt in lives in `~/.agent-board/config.json` as `dialogue_enabled`. It defaults to `true` when absent. Set it to `false` on a machine that must never execute board commands; the daemon then refuses every command with the reason `dialogue_disabled`. The doctor output reports the flag.
2. The daemon spawns the CLIs by name (`claude`, `codex`). A daemon running under systemd or launchd often has a PATH that lacks them. Set `AGENT_BOARD_CLAUDE_BIN` and `AGENT_BOARD_CODEX_BIN` to absolute paths in the daemon's service environment when needed.
3. The assistant thread uses its own token, separate from the machine tokens and the MCP token. Create one token for the assistant. Put its SHA 256 hash in the Worker secret named `MUSE_TOKEN_SHA256`. Put the plain token only in the assistant's own token store. The assistant polls `GET /api/muse/inbox` for unanswered messages and answers with `POST /api/muse/reply`.
4. Add Cloudflare Access bypass applications for the token authenticated dialogue paths, the same shape as the ingest, heartbeat, and MCP bypass applications: one for `/api/muse/inbox`, one for `/api/muse/reply`, and one covering `/api/commands/*` (the per command result endpoint). Without them, Access redirects the token calls before they reach the Worker. The board UI paths (`/api/sessions/:id/messages`, `/api/muse/messages`) stay behind the normal Access application; they are not bypassed.

## Windows probe

The Windows Codex app may not fire file based hooks. Probe before relying on hook coverage there.

1. Add a temporary log only hook on the Windows machine that appends its argv, cwd, and environment keys to a local file.
2. Run one session in the Codex app and one in the Codex CLI.
3. Compare the log. Note whether the app fired the hook, which shell ran it, and whether `node` resolved on the hook process path.
4. If the app does not fire hooks, enable the transcript watcher input source on the daemon. It sits behind the interface in `src/sender/transcript-watcher.ts`. Its parser must stay isolated from the hook path because the rollout format is not a stable interface.

## Rollback

- To cut off one machine, remove its hash from `MACHINE_TOKENS_JSON` and deploy. See `SECURITY.md`.
- To roll back the Worker, redeploy the previous git tag through the ci-cd pipeline.
- Sender problems never block the CLIs. The hook exits 0 in every case and the daemon can be stopped per machine.
