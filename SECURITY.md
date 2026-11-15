# Security

## Reporting

Report a vulnerability to the repo owner through a private channel. Do not open a public issue with token values, payloads, or board URLs.

## Secret rules

- No token, key, or credential is committed. Placeholders use the literal text `REPLACE_ME`.
- Per machine tokens live in `~/.agent-board/token` on that machine only. That directory is never synced through dotfiles.
- The Worker stores token hashes only.
- Cloudflare credentials live in a Wrangler login on an operator machine or in GitHub Secrets for the deploy workflow. They never enter the repo.

## Token model

- One ingest token per machine. The server derives the machine identity from the token.
- One MCP bearer token for agent clients. It is separate from every ingest token.
- Cloudflare Access guards the board page and the read API for people.

## Rotation runbook

Ingest token for one machine:

1. Generate a new token on the operator machine with a crypto random source.
2. Add its hash to the Worker configuration as an additional accepted hash for that machine.
3. Deploy the Worker.
4. Replace the file `~/.agent-board/token` on that machine. Keep mode 600 on macOS and Linux. Keep a current user only ACL on Windows.
5. Run `just doctor` on that machine and confirm a successful post.
6. Remove the old hash from the Worker configuration and deploy again.
7. Confirm the board still shows that machine heartbeat.

MCP token:

1. Generate a new token.
2. Add it as an additional accepted token in the Worker secret store.
3. Update each MCP client configuration.
4. Remove the old token and deploy again.

Cloudflare deploy token in GitHub Secrets:

1. Create a scoped token for the single account and the Workers scripts it deploys.
2. Replace the GitHub Secret value.
3. Run the deploy workflow once from a tag and confirm success.
4. Revoke the old token in the Cloudflare dashboard.

## Revocation

To cut off one machine at once, remove its token hash from the Worker configuration and deploy. Its daemon will fail ingest and keep spooling locally. No other machine is affected.

## Public repo hygiene

- Screenshots and demo data use synthetic machines, repos, and text only.
- Real board hostnames, account ids, and Access team domains stay out of issues, docs, and fixtures.
- Changes to any `AGENTS.md` file need human review. Those files instruct agents and are a prompt injection surface.
