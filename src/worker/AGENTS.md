# Worker

## Facts

- One Worker serves ingest, the read API, the board page, WebSocket push, and the MCP endpoint.
- The Board Durable Object owns live state in its own SQLite storage. All storage access goes through `store.ts`.
- The board sequence is assigned inside the Durable Object. It increases monotonically.
- Push payloads carry the sequence and the full changed session row. A client that sees a sequence gap calls the resync endpoint once.
- Three auth planes stay separate. The board and read API use Cloudflare Access. Ingest uses a per machine token hash. MCP uses its own bearer token.
- The local development bypass for Access runs only when an explicit environment flag is set. It is marked in `auth.ts`.
