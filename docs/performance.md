# Performance and cost model

This project treats cost as a bounded systems problem. Every hot path has a numeric cap. The caps live in one module, `src/shared/perf.ts`. The sender and the Worker import the same values. A unit test asserts that both sides agree.

## Budget table

| Surface | Cap | Value |
| --- | --- | ---: |
| Spool total size | `spoolMaxBytes` | 10,485,760 bytes |
| Spool files | `spoolMaxFiles` | 128 files |
| One spool file | `spoolMaxFileBytes` | 1,048,576 bytes |
| Tool coalescing window | `toolCoalesceMs` | 3,000 ms |
| Daemon poll floor | `daemonPollMs` | 1,000 ms |
| Events per ingest request | `ingestMaxEvents` | 50 |
| Ingest request size | `ingestMaxBytes` | 131,072 bytes |
| Daemon batch events | `daemonBatchMaxEvents` | 50 |
| Daemon batch size | `daemonBatchMaxBytes` | 120,000 bytes |
| Events per session in the Durable Object | `eventsPerSessionCap` | 200 |
| Events in total | `eventsGlobalCap` | 10,000 |
| Session rows in total | `sessionsGlobalCap` | 1,000 |
| Last seen session write throttle | `lastSeenWriteThrottleMs` | 30,000 ms |
| Heartbeat interval | `heartbeatIntervalMs` | 60,000 ms |
| Heartbeat write throttle | `heartbeatWriteThrottleMs` | 30,000 ms |
| Retry attempts | `retryMaxAttempts` | 5 |
| Retry base delay | `retryBaseMs` | 1,000 ms |
| Retry delay cap | `retryMaxMs` | 30,000 ms |
| Retry jitter cap | `retryJitterMs` | 250 ms |
| Event retention | `eventRetentionDays` | 7 days |
| Ended session retention | `sessionRetentionDays` | 30 days |
| Read API page size | `readMaxLimit` | 100 |
| MCP page size | `mcpMaxLimit` | 100 |
| Recent events page size | `recentEventsMaxLimit` | 200 |
| Dialogue command execution cap | `dialogueExecTimeoutMs` | 900,000 ms |
| Dialogue command expiry | `dialogueExpiryMs` | 86,400,000 ms |
| Dialogue held re-offer fallback | `dialogueHeldRetryMs` | 300,000 ms |
| Dialogue message size | `dialogueMessageMaxChars` | 2,000 chars |
| Dialogue result request size | `dialogueResultMaxBytes` | 65,536 bytes |
| Dialogue messages kept per thread | `dialogueThreadCap` | 100 |

## Write rules

- The daemon coalesces tool pulses by session and actor. One merged event carries the latest tool name and the summed pulse count.
- The daemon sends many events in one request. It never sends one request per tool pulse.
- State changing events flush pending tool pulses first and then flush at once.
- The Durable Object writes a session row once per changed session per ingest batch.
- A session row does not change only because time passed. A last seen update writes at most once per 30 seconds per session.
- WebSocket messages go out only for changed session rows and for machine online/offline transitions. A machine row is pushed only when its heartbeat recency crosses 120 seconds, detected on heartbeat and ingest traffic and by a Durable Object alarm. There is no per heartbeat broadcast and no periodic full board broadcast.
- The board page opens one WebSocket. It refetches only after a sequence gap. Its one second timer updates elapsed text in the page and makes no network request.
- MCP and read API calls use bounded limits. Session reads use the session primary key. Session lists use the machine and time index.
- Retention pruning deletes rows. It does not hide them.
- The default logger level is warn. Tool pulses do not log per event.

## Cost model

These are estimates. They are derived from the caps in this repo. They are not a Cloudflare invoice forecast. Cloudflare prices and free allowances change, so the model counts operations instead of money.

Definitions for one session hour:

- `S` is the number of state changing events.
- `T` is the number of raw tool pulses.
- `W` is the active seconds in the hour.
- `C` is the number of connected board pages.
- Coalesced tool batches are at most `ceil(W / 3)` for a continuously active session, because the coalescing window is 3 seconds. A state changing event can flush a pending batch early, so a safer upper bound is `ceil(W / 3) + S`.

### Normal session

Assume 10 turns, 120 tool pulses, 900 active seconds, and 30 state changing events in one hour.

Without coalescing:

- Ingest requests if a naive sender posted each event: `120 + 30 = 150`.
- Session writes if each event wrote a row: up to 150.
- Stored events: 150.
- WebSocket messages: up to `150 x C`.

With this design:

- Tool batches: at most `ceil(900 / 3) + 30 = 330`, but the actual batch count cannot exceed the number of tool pulses. The tighter bound is `min(120, 330) = 120`. In practice pulses cluster inside tool runs, so a 3 second window usually merges several pulses. The measured local flood test is the evidence for the implemented path, not this arithmetic.
- Ingest requests: at most one request per batch of merged tool events plus state events, chunked at 50 events. For 30 state events and up to 120 merged tool events, the request bound is `ceil(150 / 50) = 3` if all events are ready in one flush, and at most 150 requests in the worst timing case where every event arrives alone. The design target is the clustered case. The flood test proves the clustered bound.
- Session writes: one per changed session per batch. A batch that contains one session writes that session once.
- Stored events: one per merged tool event plus one per state event. The per session ring caps this at 200.
- WebSocket messages: one per changed session row per batch, times `C`. No change means no message.

### Heavy tool call session

Assume 3,600 tool pulses in one hour, continuous activity, and 60 state changing events.

Without coalescing:

- Ingest requests in a naive per event sender: 3,660.
- Session writes: up to 3,660.
- Stored events before any cap: 3,660.
- WebSocket messages: up to `3,660 x C`.

With this design:

- Coalesced tool batches: at most `ceil(3600 / 3) + 60 = 1,260`. This is a reduction factor of about 2.9 against 3,660 events, before batching.
- Ingest requests: batches are chunked at 50 events, but timing still decides how many flushes occur. The flush count bound is the coalesced batch count plus state flushes, at most about 1,320 requests in the worst timing case. A burst that arrives inside one daemon cycle sends as one event after coalescing, as the flood test shows.
- Session writes: at most one per changed session per ingest request. The absolute worst case follows the request count. The normal clustered case is far lower.
- Stored events: capped at 200 for this session. Older events are deleted as new ones arrive.
- WebSocket messages: only changed rows. A merged pulse that changes the pulse count is a change. A repeated pulse with no state change and no count change is not broadcast. Machine rows are pushed only on online/offline transitions (heartbeat recency crossing 120 seconds), detected on heartbeat and ingest traffic and by a Durable Object alarm. There is no per heartbeat broadcast.

The honest summary is that coalescing bounds bursts and the ring bounds storage. Timing can still spread work across an hour. No design that reports live state can make a continuously changing session cost zero. This design keeps the cost proportional to visible changes, with a hard storage ceiling.

### Heartbeats

One machine sends at most one heartbeat per 60 seconds. That is 60 requests per machine hour. The server writes a machine row at most once per 30 seconds, and a 60 second interval means the normal case writes once per heartbeat. A fleet of 4 machines sends at most 240 heartbeat requests per hour in total.

### Dialogue

Dialogue adds no requests of its own on the delivery path. Pending commands ride the existing heartbeat response, so an idle board with no commands costs exactly what heartbeats already cost. A command that runs produces at most three small result posts (running, then one terminal state), plus one Durable Object write per state change and one audit row per state change. A held command is re-offered only when the session state changes or after the 300 second fallback, so a busy session does not cause a retry loop. Message storage is bounded by the per thread cap of 100, and terminal state messages are pruned with the ended session retention.

The real cost of a delivered command is not Cloudflare operations. It is one CLI resume turn on the target machine, billed to that machine's CLI account at whatever that turn consumes. That cost is the operator's reason for posting the message, and it is stated here plainly so nobody mistakes dialogue for a free channel.

## Measured proof

`npm run perf` runs the local proof. It fires 200 rapid tool pulses through the compiled hook and daemon into the local Worker. It reports hook latency percentiles, ingest request count, Durable Object session writes, event writes, broadcasts, and spool and event window checks. `just check` also covers coalescing, batching, write on change, throttling, spool caps, and event ring caps in unit tests.

Measured on the reference VM on 2026-11-15. This VM has 1.5 shared CPUs, so treat the latency numbers as a slow machine bound, not as a promise for a desktop.

- 200 rapid tool pulses became 1 ingest request, 1 stored event, and 1 session write.
- A direct flood of 250 stored events for one session left the event window at exactly 200.
- Bundled hook latency was p50 91.3 ms and p95 108.2 ms.
- An empty Node script on the same VM measured p95 95.8 ms. Most of the hook latency is Node startup, not project code.
- The original 100 ms hook budget and the 50 ms target from the design notes are not reachable by a Node hook on this VM. The perf script asserts p95 under 150 ms on this class of machine. A faster hook needs a native shim. That is future work, and it does not change the request and write bounds, which are the cost drivers.
