# Design: immediate and delayed queue jobs

Status: **implemented** (migration `20261127000000_queue_jobs`). This document is the design
record for engineers working on Chronos. The user-facing contract is in [QUEUE_JOBS.md](QUEUE_JOBS.md).

The implementation differs from this proposal in four places:
* Idempotency keys keep the existing `manual:` storage prefix instead of `submit:`. Existing keys
  stay valid, and the namespace is still shared by manual triggers and queue submissions.
* Limits are serialised with transaction-scoped advisory locks, not `FOR UPDATE` on queue rows.
  Row locks could deadlock with job deletes that cascade to executions.
* Candidates are pre-ranked per job and per queue in SQL, so a saturated queue cannot fill the
  dispatcher batch and starve other queues.
* The SDK resolves its project id with `GET /v1/agent/identity`, because REST routes are keyed by
  project id.

The audit and proposal below are kept as written.

## 1. Terminology

Two names must never be confused:

* **Job (job name):** *what* runs. A named definition with an execution mode (HTTP, AGENT,
  WORKER), handler, timeout, retry policy and optional payload schema. Examples:
  `send-email`, `daily-report`. Job names already exist (unique per project).
* **Queue (queue name):** *how and when* executions are admitted. A named lane with a
  concurrency limit, a default priority and a paused flag. Examples: `default`, `emails`,
  `bulk`. **Queues are new.**

Every job belongs to one queue (`default` unless set). Every execution (scheduled, manual,
immediate or delayed) passes through its job's queue. That single path is what makes
monitoring and limits consistent across all three delivery types.

`chronos.queue("send-email", payload)` therefore means "submit an execution of the job
`send-email`". The execution goes into the job's queue, or into the queue named in the options.

## 2. Audit: what already exists

| Requirement | Today | Gap |
| --- | --- | --- |
| Scheduled jobs (cron, time zones, one-time) | Complete, tested (`scheduler.ts`, DST, misfire policies) | None |
| Immediate execution without cron | `POST …/jobs/:jobId/trigger` creates a durable execution (`trigger=MANUAL`) that the outbox dispatches | Addressed by job **id**, not name; no SDK API; agent tokens cannot call it; dispatch waits up to one scheduler tick (~1 s) |
| Delayed execution | Not exposed. The engine already supports "run when `next_attempt_at` is due" (retries use it) | No API to set a future `next_attempt_at` |
| Payload validation | Size and JSON-serialisability only (`jsonPayloadSchema`) | No per-job schema |
| Priority | None. The dispatcher orders by `next_attempt_at`; agents claim by `scheduled_for`; BullMQ jobs have no priority | Missing |
| Retry and backoff | Per job (`maxAttempts`, `retryBackoffMs`, `retryBackoffMaxMs`), exponential with jitter, dead letter, replay | Backoff is read from the job at failure time, so per-submission overrides are impossible |
| Concurrency limits | Per job: `ALLOW` / `FORBID` (at most one active). Per executor: worker `CHRONOS_WORKER_CONCURRENCY`, agent `concurrency` | No limit per queue, and no numeric limit per job |
| Status and history | `job_executions` + attempts + logs, filters, SSE events | Needs `queue`, `priority`, and trigger `QUEUE` in filters and events |
| Idempotency keys | Unique `(job_id, idempotency_key)`; manual keys prefixed `manual:` | Reusable as is; key namespace must be defined for queue submissions |
| Cancel before start | `POST …/cancel` works for PENDING, QUEUED, RETRY_SCHEDULED (and RUNNING, best effort) | Works; QUEUED BullMQ entries are left to fail their claim (harmless but noisy) |
| Multiple queues, worker concurrency | BullMQ has one queue per *mode* (HTTP, WORKER); worker concurrency per process | No user-level queues |
| HTTP / Agent / Worker modes | All three work for scheduled and manual executions | Queue submissions inherit this unchanged |
| PostgreSQL persistence, Redis/BullMQ delivery | Outbox: the PG row is the truth; BullMQ carries delivery; a stale sweeper re-enqueues | Reused as is |

**Conclusion.** The execution pipeline (durable row → dispatcher → BullMQ or agent claim →
leased attempt → retry or dead letter) is already shared. Queue jobs need **no second
pipeline**. The missing pieces are:
1. a submission surface: REST by job name, and SDK `queue()`
2. delay
3. priority
4. queue entities with admission control
5. payload schemas
6. per-submission retry overrides
7. a faster dispatch wake-up

## 3. Design decisions

### 3.1 Delays are timed by PostgreSQL, not BullMQ

A delayed submission is stored as `status=PENDING`, `next_attempt_at = now() + delay`, using the
database clock. The existing dispatcher hands it to BullMQ (or wakes agents) once it is due,
exactly as it does for retries.

*Rejected: BullMQ delayed jobs.* They would give Redis a second source of truth for timing. A Redis
loss or flush would then drop delayed jobs, and cancelling or listing delayed jobs would need
Redis lookups. With PostgreSQL as the timer, delayed jobs survive Redis loss, are listable
and cancellable with plain SQL, and follow the same rules as everything else.

Precision is one dispatcher tick (`CHRONOS_SCHEDULER_TICK_MS`, default 1 s). This is
documented. The maximum delay is 365 days.

### 3.2 Admission control (concurrency and pause) happens at dispatch

The dispatcher moves rows from `PENDING` / `RETRY_SCHEDULED` to `QUEUED` only while
`(QUEUED + RUNNING executions in the queue) < queue.concurrency_limit`. In the same
transaction it locks the queue rows it admits into (`FOR UPDATE`, in id order), so concurrent
dispatchers on several replicas cannot exceed the limit together. Paused queues admit nothing.

Because a `QUEUED` execution already counts toward the limit, workers and agents need no
changes: whatever they receive is already admitted. A per-job numeric limit
(`maxConcurrency`) uses the same check and generalises `FORBID` (which becomes
`maxConcurrency = 1` for API compatibility).

### 3.3 Priority

`priority` is an integer from 0 to 100 (higher runs first; default from the queue, which defaults to 50). It is honoured in
three places:
* the dispatcher: `ORDER BY priority DESC, next_attempt_at`
* BullMQ: `priority` option, mapped to BullMQ's "lower is first" scale
* agent claims: `ORDER BY priority DESC, scheduled_for`

Priority orders work *waiting in the same queue*. It does not pre-empt running work, and it
does not let one queue overtake another queue's concurrency limit.

### 3.4 Queues are logical lanes; BullMQ stays one queue per mode

The proposal keeps the current BullMQ layout (one queue per execution mode) and enforces queue
semantics in PostgreSQL at dispatch (§3.2). This needs no dynamic BullMQ queue creation and no
worker re-subscription when queues are added.

*Option, not in this proposal:* route specific queues to specific worker pools, for example
`CHRONOS_WORKER_QUEUES=emails` on a dedicated worker. It would need one BullMQ queue per
(mode, queue) and workers discovering queues dynamically. It can be added later without an
API change.

### 3.5 Submission: one API for immediate and delayed

```
POST /v1/projects/:projectId/queue
{ "job": "send-reminder",            // job NAME
  "payload": { … },
  "delayMs": 300000,                 // or "runAt": ISO time; omit both for immediate
  "priority": 80,                    // optional, 0–100
  "queue": "emails",                 // optional override of the job's queue
  "idempotencyKey": "reminder-42",   // optional
  "maxAttempts": 5, "retryBackoffMs": 2000, "retryBackoffMaxMs": 60000, "timeoutMs": 30000 }  // optional overrides
→ 201 { execution, created: true } | 200 { execution, created: false }  (idempotent replay)
```

`POST /v1/projects/:projectId/queue/batch` accepts up to 100 items and returns per-item results.

* Executions get a new trigger value, `QUEUE` (alongside `SCHEDULE`, `MANUAL`). Immediate and
  delayed are both `QUEUE`; delayed ones carry `delayed=true` and a future `nextAttemptAt` in
  responses and events. No new status is added: a delayed execution is `PENDING` until it is due.
* **Who may submit:** user sessions, project keys, and **agent tokens, on this endpoint only**.
  The SDK already holds an agent token, and enqueueing is a request/response operation that
  should work even while the WebSocket is reconnecting. Agent tokens stay confined to their own
  project and to submission. They still cannot read or manage anything.
* Unknown job name → `404`. Disabled job → `409`. Paused queue → accepted (it waits).
  Schema violation → `400 VALIDATION_FAILED` with JSON-pointer paths.
* The existing `POST …/jobs/:jobId/trigger` keeps its behaviour (immediate, `trigger=MANUAL`)
  and shares the same code path.

### 3.6 Idempotency

Keys are unique per job and shared by manual triggers and queue submissions (namespace
`submit:<key>`). A repeat returns the original execution with `created:false`, whether it is
pending, delayed, running or finished. The dedupe window is the execution retention period
(`CHRONOS_EXECUTION_RETENTION_DAYS`). After that, a key can be reused. This is documented.

### 3.7 Payload validation

`jobs.payload_schema` holds an optional JSON Schema (draft 2020-12), validated with Ajv
(compiled schemas cached per job version). The schema is set through the job API, or from the
SDK task option `payloadSchema`, which is synchronised in `hello`. It is enforced on every
submission path: queue, trigger, and scheduled executions with a static payload, which are
checked when the job is saved. `chronos.queue()` validates nothing locally. The server is the
single authority, because the submitting app may not be the app that runs the handler.

### 3.8 Retry overrides

`job_executions` gains `retry_backoff_ms` and `retry_backoff_max_ms`, copied from the job and
overridable per submission. `applyFailure` reads them from the execution instead of the
job. (`max_attempts` and `timeout_ms` are already stored per execution.)

### 3.9 Latency of immediate jobs

After a submission commits, the server publishes a dispatcher wake-up on Redis. The scheduler
loop (embedded or standalone) runs a dispatch pass immediately instead of waiting for its tick.
Expected submit-to-start latency is a few milliseconds for workers and webhooks, and one claim round-trip for
agents. If the signal is lost, the next tick still dispatches. Correctness never depends on the
signal.

### 3.10 Cancellation

Cancelling a `PENDING` (including delayed), `QUEUED` or `RETRY_SCHEDULED` execution is
definitive: it never starts. For `QUEUED` HTTP/WORKER executions, the BullMQ job is removed
as well (best effort; a leftover entry fails its claim harmlessly). `RUNNING` cancellation stays
best effort (abort signal), as today. The SDK exposes `chronos.cancel(executionId)` with the same
semantics; the endpoint is extended to agent tokens for executions they submitted.

## 4. Changes

### Database (one migration, backward compatible)

* `queues (id, project_id, name, concurrency_limit NULL = unlimited, default_priority 50, paused, created_at, updated_at)`,
  unique `(project_id, name)`; a `default` queue is created for each existing and new project.
* `jobs`: `queue_id` (NOT NULL, backfilled to the project's default queue), `payload_schema JSONB`,
  `priority INT NULL`, `max_concurrency INT NULL` (`FORBID` maps to 1).
* `job_executions`: `queue_id`, `priority`, `retry_backoff_ms`, `retry_backoff_max_ms`
  (backfilled from jobs); enum `ExecutionTrigger` gains `QUEUE`.
* Indexes: `(status, priority DESC, next_attempt_at)` for dispatch;
  `(queue_id, status)` for admission counts.

### Engine (`packages/engine`)

* `ExecutionStore.submit()` replaces `trigger()`: job lookup by id or name, schema check, delay,
  priority, queue, overrides, idempotency.
* Dispatcher: priority ordering, queue and job admission with queue row locks, pause.
* `ExecutionQueues.enqueue`: BullMQ priority; removal on cancel.
* `claimForAgent`: priority ordering.
* `applyFailure`: per-execution backoff.

### Server (`apps/server`)

* `QueuesModule`: CRUD `GET/POST /projects/:id/queues`, `PATCH/DELETE …/queues/:name`, and
  `POST …/queues/:name/pause|resume`. Deleting a queue requires it to have no jobs.
* `POST /projects/:id/queue` and `/queue/batch`. Auth guard: agent tokens allowed on these routes only.
* Executions API: filters `queue`, `trigger=QUEUE`, `delayed=true`, sort by priority; stats per queue.
* Job API: `queue`, `priority`, `maxConcurrency`, `payloadSchema` fields.
* SSE `execution.updated` gains `queue`, `priority`, `delayed`.
* Dispatcher wake-up signal (Redis pub/sub), subscribed by the scheduler runtime.

### SDK (`packages/sdk`)

```ts
const { executionId, created } = await chronos.queue('send-email', payload);
await chronos.queue('send-reminder', payload, { delay: 300_000 });            // or { runAt: Date }
await chronos.queue('rebuild-index', payload, { priority: 90, queue: 'bulk', idempotencyKey: 'idx-7',
                                                 maxAttempts: 5, backoff: { delay: 2000, maxDelay: 60_000 } });
await chronos.cancel(executionId);                                            // true if it had not started
chronos.task('send-email', { queue: 'emails', priority: 60, payloadSchema: { type: 'object', required: ['to'] } }, handler);
```

`queue()` works before `start()`: it only needs `server` and the token. It retries transient
failures (network errors, `503`) with the same idempotency key. If the caller gave no key, the
SDK generates one per call, so a retried call cannot create duplicates. Errors are typed:
`ChronosValidationError` (schema), `ChronosNotFoundError` (unknown job) and `ChronosConflictError`.

### Documentation

Update API_REFERENCE, WEBSOCKET_PROTOCOL (new event fields), DASHBOARD_INTEGRATION (queues
page, delayed and priority columns), the SDK section of the README, and architecture (§3.1–3.4
as decisions).

## 5. Test plan

* **Unit:** priority mapping, delay bounds, schema validation errors, the SDK retry
  idempotency-key reuse.
* **Integration (real PostgreSQL and Redis):**
  * immediate and delayed submission in each mode (HTTP, AGENT, WORKER)
  * a delayed job does not run early and runs within one tick of its time
  * cancelling a delayed job means it never runs
  * the queue concurrency limit holds with 3 concurrent dispatchers and 2 workers
  * a paused queue admits nothing, and resume drains it
  * priority order within a queue
  * per-submission retry overrides lead to dead letter after N attempts
  * idempotent replay returns the same execution (also across concurrent requests)
  * agent tokens can submit but cannot read
  * schema rejection
  * Redis flushed while jobs are delayed: they still run
  * dispatcher wake-up latency, and fallback without the signal
* **Docker e2e:** SDK `queue()` immediate and delayed against the compose stack.

## 6. Delivery guarantees (unchanged)

All three delivery types are **at-least-once**, with the same leases, retries, dead letter
and idempotency keys. Exactly-once is not claimed.
