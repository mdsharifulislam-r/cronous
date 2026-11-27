# Chronos architecture

This document records the architecture, the reliability and security risks identified
during the design review, and the decisions taken to address them. Every decision below
is implemented and covered by tests unless marked otherwise.

## 1. Component overview

```
                 ┌──────────────────────────── Chronos ─────────────────────────────┐
 Application     │ server (NestJS)                      scheduler loop              │
 ┌───────────┐   │ ├─ REST API /v1 + dashboard          ├─ due schedules (SKIP LOCKED)
 │ @chronos/ │WSS│ ├─ agent gateway  ◄── claims ──────  ├─ outbox dispatch ─► BullMQ ─┐
 │ sdk       ├───┼►│   (PG claim, Redis wake-ups)       └─ reaper (leases, timeouts)  │
 └───────────┘   │ ├─ auth / RBAC / audit                                           │
 HTTP endpoint ◄─┼─┤ embedded webhook worker ◄──────────────────────────────────────┤
                 │ worker app (Mode C handlers, extra webhook capacity) ◄────────────┘
                 └──────────┬───────────────────────────────────────┬───────────────┘
                            │ durable truth                         │ delivery + signals
                       PostgreSQL                              Redis (namespaced)
```

* **PostgreSQL is the source of truth** for organizations, credentials, jobs, schedules,
  executions, attempts, logs and audit history.
* **Redis is a delivery and coordination layer**: BullMQ queues, pub/sub wake-ups,
  login rate limits. Losing Redis delays work but never loses it: everything is
  recovered from PostgreSQL (§3.2, §3.3).
* **Applications talk only to the Chronos server** (HTTPS + WSS). The SDK never receives
  Redis or database credentials.
* **One image, three entrypoints.** The server embeds the scheduler loop and a webhook
  worker by default, so a single container is a complete install. The standalone
  scheduler and worker processes scale those roles out separately.

## 2. Monorepo

| Path | Purpose |
| --- | --- |
| `apps/server` | NestJS: REST API, auth/RBAC, agent WebSocket gateway, dashboard hosting, embedded scheduler and webhook worker |
| `apps/scheduler` | Standalone scheduler loop (scheduling, dispatch, recovery) |
| `apps/worker` | Standalone worker: Mode C handlers and/or HTTP webhooks |
| `apps/dashboard` | Next.js dashboard (separate process; talks to the API through its own server) |
| `apps/dashboard-lite` | Static web UI (no build step), served by the server at `/dashboard` |
| `packages/database` | Prisma schema, migrations, seed |
| `packages/shared` | Env validation, token/password crypto, Redis keyspace, cron/timezone planner |
| `packages/protocol` | Versioned agent wire protocol and job-definition schemas (shared by server and SDK) |
| `packages/engine` | Scheduler, dispatcher, execution state machine, reaper, webhook executor, worker runtime |
| `packages/sdk` | `@cronouss/cronous` |
| `examples/sdk-app` | Example application using the SDK |

**Why the engine is a plain library and the scheduler/worker are not Nest apps:** the
same scheduling, dispatch and execution code runs inside the server and in the standalone
processes. Keeping it free of framework dependencies avoids two implementations, and the
standalone processes stay small (no HTTP framework, just a health endpoint).

## 3. Reliability

### 3.1 Duplicate dispatch across scheduler replicas

*Risk:* two scheduler replicas see `next_run_at <= now()` and both dispatch the same
occurrence. Redis locks alone cannot prevent this durably: a lock can expire during a GC
pause or a partition, after which both holders act.

*Decision* (`SchedulerEngine.tick`): one PostgreSQL transaction per batch.
1. `SELECT … FROM job_schedules … WHERE state='ACTIVE' AND next_run_at <= now() … FOR UPDATE OF s SKIP LOCKED`.
   Replicas partition the due set without blocking each other.
2. Each occurrence becomes a `job_executions` row with `idempotency_key = 'sched:<ISO time>'`;
   the unique constraint `(job_id, idempotency_key)` plus `ON CONFLICT DO NOTHING` makes a
   duplicate occurrence impossible even if the row lock were bypassed (e.g. a restored
   backup re-presenting an old `next_run_at`).
3. `next_run_at` advances in the same transaction, computed from the **database clock**,
   so host clock skew cannot cause early or duplicate firing.

*Tests:* five concurrent scheduler replicas over 25 due jobs produce exactly 25
executions. A re-presented occurrence creates nothing.

### 3.2 Lost dispatch between commit and enqueue (transactional outbox)

Executions are committed `PENDING`. The dispatcher marks a batch `QUEUED` in one
transaction (`FOR UPDATE SKIP LOCKED`) and only then adds BullMQ jobs whose id is
`<execution>-<attempt>`. If the process dies in between, the stale sweeper re-adds
`QUEUED` rows older than 60s whose BullMQ job is missing. A duplicate delivery is
harmless because executors claim rows conditionally (§3.3). *Tests:* a delivery deleted
from Redis is restored by the sweeper.

### 3.3 At-least-once execution, leases, retries, recovery

* **Claim:** `UPDATE job_executions SET status='RUNNING', lease_owner=$me, lease_expires_at=now()+lease, attempt_count=attempt_count+1 WHERE id=$id AND status='QUEUED'`.
  Zero rows means someone else has it. *Tests:* concurrent duplicate deliveries run the
  handler once; ten executions across two workers each run exactly once.
* **Leases:** workers renew every `lease/3`; agents renew through heartbeats. A failed
  renewal (cancelled or reaped) aborts the handler via `AbortSignal`.
* **Fencing:** results and renewals are accepted only if `lease_owner` and
  `attempt_count` still match, so a late result from an executor that lost its lease is
  discarded (`result_ack.accepted = false`). Its side effects may already have happened,
  which is why delivery is **at-least-once, never exactly-once**. Handlers receive a
  stable `idempotencyKey` to de-duplicate their own side effects.
* **Reaper** (safe on every replica): expired leases → attempt `ABANDONED`; attempts
  older than `timeout + 30s` → `TIMED_OUT` (catches executors that keep renewing while
  stuck); stale agents/workers → `OFFLINE`; optional retention pruning.
* **Retries:** exponential backoff with equal jitter, capped by `retryBackoffMaxMs`,
  until `maxAttempts`, then `DEAD_LETTERED`. Non-retryable failures (`NonRetryableError`,
  HTTP 4xx, blocked destinations) go to `FAILED` immediately. Dead letters can be replayed
  (`POST …/executions/:id/retry`) with a fresh attempt budget.
* **Snapshots:** timeout, max attempts and payload are copied onto the execution, so
  editing a job never changes the rules of an execution in flight.

### 3.4 Misfires, timezones, overlap

* `misfirePolicy`: `FIRE_ONCE` (default, one catch-up for the latest missed
  occurrence), `SKIP` (drop occurrences later than `misfireGraceMs`), `FIRE_ALL`
  (replay, capped by `maxCatchUp`). Missed occurrences are found by walking *backwards*
  from now, so a per-minute schedule after a month of downtime costs at most 1000
  iterations, not 43,200.
* Cron expressions (5 fields, minute granularity) are evaluated in the schedule's IANA
  time zone (default: the project's). DST behaviour, verified by tests: a local time
  **skipped** by spring-forward fires once, shifted by the transition (02:30 becomes
  03:30); a local time **repeated** by fall-back fires once, on its first occurrence.
* `concurrencyPolicy: FORBID` skips occurrences (and rejects manual triggers) while a
  previous execution is active.
* Pausing clears `next_run_at`; resuming starts from the next future occurrence (paused
  periods are not backfilled). Re-applying an identical definition (an SDK reconnecting)
  never moves `next_run_at`.

### 3.5 Redis

* Every key and BullMQ queue lives under `CHRONOS_NAMESPACE` (validated
  `^[a-z][a-z0-9_-]{0,31}$`), so Chronos can share a Redis instance with your apps.
* Startup warns unless `maxmemory-policy` is `noeviction` (BullMQ requirement).
* Producer connections fail fast; worker/subscriber connections retry forever.
* Shutdown order: loops and workers stop in `onModuleDestroy`, queues close in
  `beforeApplicationShutdown`, connections close in `onApplicationShutdown`.

### 3.6 Agent delivery across server replicas

An agent's WebSocket terminates on one server replica, so agent work is **not** put in
BullMQ. Each agent session *pulls*: it claims `QUEUED` agent executions for task names it
has handlers for, up to its declared concurrency, with `FOR UPDATE SKIP LOCKED`. Several
replicas and several agents of one project therefore share work with no coordination
beyond PostgreSQL. Wake-ups come from Redis pub/sub (published by the dispatcher) plus a
5s poll, so a lost pub/sub message only delays delivery.

* **Disconnects do not fail running executions.** The SDK reconnects (to any replica)
  with full-jitter exponential backoff, reports its running executions in the first
  heartbeat (renewing their leases), and re-sends results the server has not acknowledged.
  If it never returns, the leases expire and the reaper retries the work elsewhere.
  *Tests:* a result produced while disconnected is accepted after the reconnect; a
  vanished agent's execution is retried on another agent.
* Half-open connections are detected on both sides (missed heartbeats on the server,
  missed pongs in the SDK).
* The handshake carries `protocolVersion`. Unsupported versions, bad tokens, project
  mismatches and invalid task definitions close with application codes (4001–4003) that
  the SDK treats as fatal instead of reconnecting forever.
* Cancellation is broadcast over Redis to the replica holding the agent, which sends
  `cancel`; the handler's `AbortSignal` fires.

### 3.7 Immediate and delayed jobs, queues

Submissions (`chronos.queue()`, `POST /queue`) create the same durable PENDING execution as
schedules and manual triggers. There is no second pipeline. Two decisions shape it:

* **Delays are timed by PostgreSQL** (`next_attempt_at` in the future), not by BullMQ delayed
  jobs. Redis never holds the only copy of a delayed job: it survives Redis loss and can be listed
  and cancelled with SQL. Precision is one scheduler tick, and an immediate submission
  additionally wakes the dispatcher over Redis.
* **Queues are logical admission lanes, enforced at dispatch.** The dispatcher admits a due
  execution only while its queue is not paused and both the queue (`concurrency_limit`) and the job
  (`max_concurrency`, or 1 for FORBID) have a free slot. QUEUED and RUNNING occupy slots, so
  executors need no knowledge of limits. Candidates are pre-ranked per job and per queue against
  the remaining capacity, so a saturated queue cannot starve others. Final admission happens under
  transaction-scoped advisory locks (sorted keys). Row locks are avoided there, because they could
  deadlock with job deletes that cascade the other way. BullMQ keeps one queue per execution mode,
  and priorities are passed to it.

Details: [QUEUE_JOBS.md](QUEUE_JOBS.md) and the design record [QUEUE_JOBS_DESIGN.md](QUEUE_JOBS_DESIGN.md).

## 4. Security

### 4.1 Credentials

* Opaque 256-bit tokens with kind prefixes: `chr_u_` (user session), `chr_p_` (project
  API key), `chr_a_` (agent), `chr_b_` (bootstrap). Only SHA-256 digests are stored. A
  fast hash is sufficient for 256-bit random input, and the digest is the lookup key.
* The prefix must match the stored kind, and each route declares accepted principal
  types (default: users only). Agent tokens work only on the agent WebSocket, and the
  bootstrap token only on `POST /v1/bootstrap`.
* Rotation issues a replacement and keeps the old token valid for a grace period (0–7
  days). A credential rotates at most once (row lock). Archiving a project revokes all of
  its credentials.
* Opaque tokens instead of JWTs: revocation is immediate and there is no signing key to
  rotate.

### 4.2 Passwords and login

scrypt (N=2^15, r=8, p=1) from `node:crypto`. Unknown emails still pay for a full
verification, so timing does not reveal accounts. Per-email lockout lives in Redis and
applies across replicas. Org admins can create users with an initial password but can
never reset an existing user's password.

### 4.3 Bootstrap

The install is unusable until bootstrapped. The bootstrap token comes from
`CHRONOS_BOOTSTRAP_TOKEN` or is generated and printed once; only its hash is stored. The
bootstrap transaction locks the singleton `system_state` row: exactly one of many
concurrent attempts succeeds (tested). Authentication is never disabled.

### 4.4 Authorization

`OWNER > ADMIN > MEMBER > VIEWER` per organization. Non-members get 404. Project API keys
act inside their own project with at most `MEMBER` rights (jobs and executions, never
credentials or members). Admins cannot grant or modify `OWNER`. The last owner is
protected by locking the target and all owner rows in one ordered statement, which is
both race- and deadlock-free.

### 4.5 Webhooks (Mode A)

* **SSRF:** every resolved address is checked *inside the socket's DNS lookup*, which
  defeats DNS rebinding. Loopback, link-local (including `169.254.169.254` cloud
  metadata), multicast and reserved ranges are always blocked; IPv4-mapped IPv6 cannot
  bypass the rules. Private ranges are allowed by default because self-hosted apps usually
  live on private networks; set `CHRONOS_WEBHOOK_ALLOW_PRIVATE=false` to block them. Use
  `CHRONOS_WEBHOOK_ALLOWED_CIDRS` for explicit exceptions (e.g. `127.0.0.1/32`).
* Redirects are not followed. Response bodies are truncated to 4 KB.
* Optional signing: `X-Chronos-Signature: t=<unix>,v1=<HMAC-SHA256(secret, "<t>.<body>")>`.
* API responses mask credentials, signing secrets and secret-looking headers. A masked
  value sent back on update keeps the stored secret, so a form that round-trips the
  masked object cannot overwrite credentials with `********`.

### 4.6 Dashboard

Static assets with a strict CSP (`script-src 'self'`, no framing). All dynamic text is
rendered through DOM text nodes; tests assert the script has no HTML-string sinks. The
session token is kept in `sessionStorage`.

### 4.7 Long-lived connections

Agent WebSockets and dashboard event streams authenticate once, at connect time. Both
re-validate their credential every `CHRONOS_CREDENTIAL_RECHECK_MS` (default 30 s): a
revoked or expired token, an archived project or (for streams) a removed membership
closes the connection. Agents receive close code `4001`, which the SDK treats as fatal.

### 4.8 Dashboard event stream

`GET /v1/projects/:id/events` is Server-Sent Events over the normal authenticated API.
Changes are discovered by polling `job_executions.updated_at` (indexed per project) with an
overlap window and de-duplication on (status, attempt). Polling is used, rather than having
writers publish, because executions are written by several kinds of processes on several
hosts. Every one of them already bumps `updated_at`, so polling cannot miss a transition
made by a component that forgot to publish. One poll per server process serves all streams,
and it runs only while a stream is open. See [WEBSOCKET_PROTOCOL.md](WEBSOCKET_PROTOCOL.md).

## 5. API conventions

REST under `/v1`; health at `/health/live` and `/health/ready`; dashboard at
`/dashboard`; agents at `/v1/agent/ws`. Responses use `{ data, meta }` /
`{ error: { code, message, details? }, meta }`. `X-Request-Id` is honoured or generated
and logged on every line. Inputs are validated with strict Zod schemas (unknown fields
are rejected). Database overload (pool or transaction-start timeouts) returns a
retryable `503` with `Retry-After`.

## 6. Known limitations and trade-offs

* **At-least-once only.** Handlers must be idempotent; exactly-once is not claimed.
* **The SDK cannot kill synchronous code.** On timeout the attempt is reported as timed
  out and the `AbortSignal` fires, but a handler that ignores the signal keeps running in
  the background.
* **Webhook secrets are stored as plain JSON** in `jobs.http_config` (masked in API
  responses). Protect database access and backups accordingly. Encryption at rest with a
  KMS key is a sensible next step.
* **Mode C handlers run with Chronos' database credentials** inside the worker process.
  Only deploy trusted code there; use Mode B (SDK) to run code inside your own app.
* One schedule per job; cron is minute-granular.
* Execution history is kept for `CHRONOS_EXECUTION_RETENTION_DAYS` (default 30, 0 = forever).

## 7. Possible next steps

Prometheus metrics endpoint; encryption at rest for webhook secrets; general API rate
limiting; audit-log retention; SDKs for other
languages (the protocol is plain JSON over WebSocket); job editing in the dashboard;
multiple schedules per job.
