# Chronos real-time protocols

Chronos has **two unrelated real-time channels**. Do not mix them up:

| | Agent protocol | Dashboard real-time protocol |
| --- | --- | --- |
| Purpose | Deliver executions to application code (`@sharifulislam1/cronous`) and collect results | Tell a UI that something changed |
| Transport | WebSocket, `GET /v1/agent/ws` | Server-Sent Events, `GET /v1/projects/:projectId/events` |
| Credential | Agent token `chr_a_` (which can also submit jobs over REST, see [QUEUE_JOBS.md](QUEUE_JOBS.md)) | User session `chr_u_` or project key `chr_p_` |
| Direction | Bidirectional | Server → client only |
| Reliability | At-least-once execution delivery with leases, acks and result acks | Best-effort change notifications; the REST API is the source of truth |
| Defined in | `packages/protocol/src/messages.ts` | `apps/server/src/modules/events/` |

A browser dashboard never opens the agent WebSocket, and an agent token cannot open the
event stream.

---

## Agent protocol

Version 1. Implemented by `@sharifulislam1/cronous`; most applications never see these frames.

### Connection and authentication

* `GET /v1/agent/ws` with `Authorization: Bearer chr_a_…`. Use WSS in production.
* The token is checked during the HTTP upgrade. A missing, invalid or non-agent token gets
  a plain `HTTP 401` and no WebSocket is opened. An unknown path gets `404`, and a server shutting
  down gets `503`.
* After the upgrade, the token is re-checked at most every `CHRONOS_CREDENTIAL_RECHECK_MS`
  (default 30 s, on heartbeats and work claims). Revoking the credential, letting a rotated
  credential's grace period expire, or archiving the project closes the socket with `4001`.
* Frames are JSON text, up to 256 KiB. Binary frames close the connection with `4000`.

### Handshake

1. The client sends `hello` within 10 s, or the server closes with `4004`.
2. The server synchronises the declared tasks into jobs, then registers or updates the agent
   record (status `ONLINE`), and answers `welcome`.

```jsonc
// client -> server
{ "type": "hello", "protocolVersion": 1, "sdkVersion": "0.1.0",
  "instanceId": "k3J9…",            // random per process; reused across reconnects
  "project": "storefront",            // must equal the token's project slug, else 4003
  "hostname": "api-1", "concurrency": 10,
  "tasks": [ { "name": "daily-report", "schedule": { "cron": "0 2 * * *", "timezone": "Asia/Dhaka" },
               "timeoutMs": 300000, "maxAttempts": 3 } ] }

// server -> client
{ "type": "welcome", "protocolVersion": 1, "agentId": "uuid", "heartbeatIntervalMs": 10000,
  "tasks": [ { "name": "daily-report", "jobId": "uuid", "managedBy": "sdk" | "api", "nextRunAt": "ISO" | null } ] }
```

Task definitions may also carry `queue` (created on first use), `priority` (0–100),
`maxConcurrency` and `payloadSchema` (JSON Schema). A schema that does not compile fails the
handshake with `INVALID_PAYLOAD_SCHEMA` and close code `4003`.

`managedBy: "api"` means a job with that name was created through the API. Its configuration
wins, and the SDK's definition is ignored.

### Messages after the handshake

| Message | Direction | Payload | Server or client behaviour |
| --- | --- | --- | --- |
| `execute` | S→C | `{executionId, attempt, task, idempotencyKey, scheduledFor, payload?, timeoutMs}` | Sent only when the agent has free capacity (pull model: the session claims admitted executions from PostgreSQL with `SKIP LOCKED`, highest priority first). The same message is used for scheduled, manual, immediate and delayed executions |
| `ack` | C→S | `{executionId, attempt}` | Must arrive within 30 s, or the attempt fails as `NO_ACK` (retryable) |
| `heartbeat` | C→S | `{running:[{executionId, attempt}]}` | Every `heartbeatIntervalMs`. Renews the leases of the listed executions. Executions the server no longer assigns to this agent get a `cancel`. Three missed intervals terminate the socket |
| `log` | C→S | `{executionId, attempt, level, message(≤4000), data?}` | Stored as an execution log if this agent still holds the attempt |
| `result` (success) | C→S | `{executionId, attempt, status:"succeeded", output?}` | Completes the execution |
| `result` (failure) | C→S | `{executionId, attempt, status:"failed", error:{message, code?, retryable=true, timedOut=false}}` | `retryable:false` → `FAILED`; otherwise retry with backoff or `DEAD_LETTERED` |
| `result_ack` | S→C | `{executionId, attempt, accepted}` | `accepted:false` means the result came too late (lease lost, cancelled) and was discarded. The SDK keeps results until acked and resends them after reconnecting |
| `cancel` | S→C | `{executionId, attempt, reason}` | User cancellation (delivered across replicas via Redis), or the lease is no longer held. The SDK aborts the handler's `AbortSignal` |
| `goodbye` | C→S | `{reason?}` | Graceful shutdown: the agent is marked `DRAINING` and receives no new work |
| `error` | S→C | `{code, message}` | Sent before a protocol close. Codes: `MALFORMED_FRAME`, `INVALID_MESSAGE`, `NOT_REGISTERED`, `DUPLICATE_HELLO`, `UNSUPPORTED_PROTOCOL`, `DUPLICATE_TASK`, `PROJECT_MISMATCH`, `INVALID_PAYLOAD_SCHEMA`, `UNAUTHORIZED`, `CREDENTIAL_REVOKED` |

### Close codes

| Code | Meaning | SDK reaction |
| --- | --- | --- |
| 1000 | Normal | – |
| 1001 | Server shutting down | Reconnect (to any replica) |
| 4000 | Protocol error | Reconnect |
| 4001 | Unauthorized: token revoked or expired, project archived | **Fatal**: the SDK stops |
| 4002 | Unsupported protocol version | **Fatal** |
| 4003 | Invalid registration (project mismatch, duplicate task) | **Fatal** |
| 4004 | Handshake timeout | Reconnect |
| 4005 | Superseded by a newer connection of the same instance | Reconnect |

### Disconnection and recovery

* A disconnect does **not** fail running executions. Their leases stay valid until
  `CHRONOS_LEASE_MS`, and the reconnected agent keeps renewing them through `heartbeat`,
  on any replica.
* If the agent does not return, the reaper marks the attempt `ABANDONED` after the lease
  expires and schedules a retry. That is why handlers must be idempotent: delivery is at least once,
  not exactly once.
* When the socket closes, the agent row becomes `OFFLINE`, unless a newer session of the same
  instance has already taken over.

### Workers

Central workers (Mode C) do **not** use WebSockets. They consume BullMQ queues in Redis,
claim executions in PostgreSQL with lease fencing, and write a heartbeat into the `workers`
table. Their status reaches the dashboard through `GET /v1/workers` and `worker.updated`
events.

---

## Dashboard real-time protocol

`GET /v1/projects/:projectId/events`: Server-Sent Events (`text/event-stream`).

### Authentication and authorization

* `Authorization: Bearer <chr_u_… | chr_p_…>`, the same token as the REST API. The role must be at least
  VIEWER in the project's organization. Errors before the stream starts are ordinary JSON
  envelopes: `401`, `403` (agent token), `404` (no access or archived project), and `503` when
  `CHRONOS_EVENTS_MAX_STREAMS` is reached (`Retry-After: 5`).
* The browser `EventSource` API cannot send headers. Use `fetch()` with a streaming reader, or
  a library such as `@microsoft/fetch-event-source`. Tokens are never accepted in the URL.
* Every `CHRONOS_CREDENTIAL_RECHECK_MS`, the server re-checks the token, the user's membership and
  whether the project is archived. When any of them fails, it sends `event: close` with
  `{"reason":"unauthorized"}` and ends the stream.

### Event format

```
retry: 3000

event: ready
data: {"projectId":"…","serverTime":"2026-11-26T09:00:00.000Z","pollIntervalMs":1000}

id: 1
event: execution.updated
data: {"id":"…","jobId":"…","jobName":"send-report","status":"RUNNING", …}

: keepalive
```

| Event | Payload | Emitted when |
| --- | --- | --- |
| `ready` | `{projectId, serverTime, pollIntervalMs}` | Once, right after connecting |
| `execution.updated` | `{id, jobId, jobName, queue, priority, delayed, status, trigger, mode, attemptCount, maxAttempts, scheduledFor, nextAttemptAt, startedAt, finishedAt, lastError, updatedAt}` | An execution of the project is created, or its status or attempt number changes, in any process (server, scheduler, worker) |
| `agent.updated` | Agent fields as in `GET …/agents` plus `projectId`; `{id, projectId, status:"REMOVED"}` after deletion | An agent of the project connects, starts draining, goes offline or is removed |
| `worker.updated` | Worker fields as in `GET /v1/workers` | A central worker changes status. Sent only to user sessions, because workers are installation-wide |
| `close` | `{reason: "unauthorized" \| "server shutting down"}` | The server is ending the stream |
| `: keepalive` (comment) | – | Every 15 s, so proxies do not time out the idle connection |

### Semantics and client rules

* **Notifications, not a log.** Load state with REST, then apply events as upserts keyed by
  `id`. An event is the latest state of that object, not a delta.
* **No replay.** `id:` is a per-connection sequence number, and `Last-Event-ID` is not honoured.
  After any reconnect, refetch the visible lists before applying new events.
* **Latency.** Changes are detected by polling `job_executions.updated_at`, with an overlap
  window and de-duplication. That runs once per server process, for all open streams, and only
  while at least one stream is open. Expect a delay of up to `CHRONOS_EVENTS_POLL_MS`
  (default 1 s).
* **Duplicates are possible.** Right after connecting, changes from the previous ~10 s may be
  re-sent, and a server restart resets de-duplication. Upserts make this harmless.
* **Lease renewals and log lines are not events.** Tail logs with
  `GET …/executions/:id/logs?afterId=` while an execution is `RUNNING`.
* **Scaling.** Each server replica polls independently, at one query per interval for executions,
  plus agents and workers. With N replicas that each have open streams, the database load is
  N × (3 queries / poll interval).
* **Proxies.** Responses set `Cache-Control: no-cache, no-transform` and
  `X-Accel-Buffering: no`. For nginx, also set `proxy_buffering off` and a `proxy_read_timeout`
  above 15 s.
