# Scheduled, immediate and delayed jobs

Chronos runs jobs in three ways. All three use the same pipeline, limits, retries and history:

| Delivery type | How it is created | `trigger` |
| --- | --- | --- |
| **Scheduled** | A cron expression or one-time `runAt` on the job (time zones, DST, misfire policies) | `SCHEDULE` |
| **Immediate** | `chronos.queue(job, payload)` or `POST /v1/projects/:id/queue` | `QUEUE` |
| **Delayed** | The same, with `delay` / `runAt` | `QUEUE` (with `delayed: true` while waiting) |
| *(Run now)* | Dashboard or `POST …/jobs/:jobId/trigger` | `MANUAL` |

Immediate and delayed jobs are **not** cron expressions. They are one-off submissions of an
existing job.

## Jobs and queues are different things

* **Job (name):** *what* runs. Examples: `send-email`, `daily-report`. A job has an execution mode
  (agent, central worker, or HTTP webhook), a timeout, a retry policy and an optional payload schema.
  Job names allow letters, digits, `.`, `_`, `:` and `-`.
* **Queue (name):** *how many run at once, in which order, and whether anything runs*.
  Examples: `default`, `emails`, `bulk`. A queue has a concurrency limit, a default priority and a
  pause switch. Queue names are lowercase letters, digits, `_` and `-`.

Every job belongs to one queue (`default` unless set). Every execution of the job goes through that
queue, whether scheduled, immediate, delayed or manual. A single submission can name a different
queue.

## SDK

```ts
import { Chronos, ChronosValidationError } from '@cronouss/cronous';

const chronos = new Chronos({ server: process.env.CHRONOS_SERVER!, project: 'storefront' });

// Declare handlers (in the app that runs them)
chronos.task('send-email', {
  queue: 'emails',                     // created on first use if missing
  priority: 60,                        // 0-100, higher first
  maxConcurrency: 20,                  // at most 20 send-email executions at once, across all agents
  maxAttempts: 5, retryBackoffMs: 2000, retryBackoffMaxMs: 60_000,
  payloadSchema: { type: 'object', required: ['to'], properties: { to: { type: 'string', format: 'email' } } },
}, async (ctx) => {
  await mailer.send(ctx.payload.to, { idempotencyKey: ctx.idempotencyKey });
});
await chronos.start();

// Submit work (from any app of the project; start() is not required for submitting)
await chronos.queue('send-email', { to: 'a@example.com' });                         // immediate
await chronos.queue('send-reminder', { userId: 7 }, { delay: 300_000 });            // in 5 minutes
await chronos.queue('send-reminder', { userId: 7 }, { runAt: '2026-12-01T09:00:00Z' });
const execution = await chronos.queue('rebuild-index', { shard: 3 }, {
  priority: 90, queue: 'bulk', idempotencyKey: 'rebuild-3-2026-11-27',
  maxAttempts: 2, backoff: { delay: 1000, maxDelay: 10_000 }, timeoutMs: 120_000,
});
// → { id, jobId, jobName, queue, status: 'PENDING', trigger: 'QUEUE', priority, delayed, scheduledFor, idempotencyKey, created }

await chronos.cancel(execution.id);   // true if it had not started yet; false otherwise
```

| `queue()` option | Meaning |
| --- | --- |
| `delay` | Milliseconds from now (0 to 365 days) |
| `runAt` | Date or ISO string; a past time runs immediately |
| `priority` | 0–100 (default: the job's priority, else the queue's default, else 50) |
| `queue` | Queue name overriding the job's queue; it must exist |
| `idempotencyKey` | Same key + same job → the original execution (`created: false`). Generated per call if omitted |
| `maxAttempts`, `backoff.delay`, `backoff.maxDelay`, `timeoutMs` | Per-execution overrides of the job's settings |

**Errors.** All of them extend `ChronosRequestError`, which carries `status`, `code` and `details`:

| Error | When |
| --- | --- |
| `ChronosValidationError` (400) | Invalid options, or a payload that fails the job's `payloadSchema` (`details: [{path:"payload.to", message}]`) |
| `ChronosNotFoundError` (404) | Unknown job or queue |
| `ChronosConflictError` (409) | Disabled job |
| `ChronosAuthError` (401/403) | Bad or revoked token |
| `ChronosConfigError` | The token belongs to a different project than `project` |

Network errors, `429`, `502`, `503` and `504` are retried up to 5 times with the **same idempotency
key**, so one `queue()` call creates at most one execution.

`queue()` and `cancel()` authenticate with the agent token (`chr_a_`). Agent tokens can submit jobs
and cancel executions that have not started. They cannot read executions or change anything else.

## REST

### Submit

`POST /v1/projects/:projectId/queue`. Accepts user sessions, project keys (`chr_p_`) and agent tokens; requires the MEMBER role.

```json
{ "job": "send-reminder",
  "payload": { "userId": 7 },
  "delayMs": 300000,
  "priority": 80,
  "queue": "emails",
  "idempotencyKey": "reminder-7",
  "maxAttempts": 5, "retryBackoffMs": 2000, "retryBackoffMaxMs": 60000, "timeoutMs": 30000 }
```

All fields except `job` are optional. Use `runAt` (ISO time) instead of `delayMs`, not both.

* `201 { execution, created: true }`. A repeated idempotency key returns `200 { …, created: false }`.
* `execution` is `{id, jobId, jobName, queue, status, trigger, priority, delayed, scheduledFor, nextAttemptAt, idempotencyKey, maxAttempts, timeoutMs, createdAt}`.
* Errors:
  * `400 VALIDATION_FAILED`: schema or payload-schema violation, with `details`
  * `404`: unknown job or queue
  * `409`: disabled job

### Batch

`POST /v1/projects/:projectId/queue/batch` with `{ "items": [<submission>, …] }` (1–100). Returns `200`
with:

```json
{ "results": [ { "index": 0, "outcome": "created", "execution": { } },
               { "index": 1, "outcome": "error", "error": { "status": 404, "code": "NOT_FOUND", "message": "Job \"x\" not found" } } ],
  "summary": { "created": 1, "duplicate": 0, "failed": 1 } }
```

Items are independent: each runs in its own transaction.

### Queues

| Method | Path | Role | Notes |
| --- | --- | --- | --- |
| GET | `/v1/projects/:id/queues` | VIEWER (user, key) | `[{id, name, description, concurrencyLimit, defaultPriority, paused, counts:{waiting, delayed, retrying, queued, running}, jobs, createdAt, updatedAt}]`; `default` always exists |
| GET | `/v1/projects/:id/queues/:name` | VIEWER (user, key) | One queue with counts |
| POST | `/v1/projects/:id/queues` | ADMIN (user) | `{name, description?, concurrencyLimit? (null = unlimited), defaultPriority? = 50}`; `409` if the name exists |
| PATCH | `/v1/projects/:id/queues/:name` | ADMIN (user) | `{description?, concurrencyLimit?, defaultPriority?}` |
| DELETE | `/v1/projects/:id/queues/:name` | ADMIN (user) | `204`; `409` for `default`, for queues that still have jobs, or for unfinished executions |
| POST | `/v1/projects/:id/queues/:name/pause` · `/resume` | MEMBER (user, key) | A paused queue accepts submissions and admits nothing; running executions continue |

Count meanings:
- `waiting`: due but not admitted (paused, or at a limit)
- `delayed`: future run time
- `retrying`: waiting for a retry backoff
- `queued`: admitted, waiting for an executor
- `running`

### Job fields

Jobs (`POST`/`PATCH …/jobs`) take `queue` (name, default `default`; it must exist), `priority`
(0–100 or null), `maxConcurrency` (≥1 or null) and `payloadSchema` (JSON Schema draft 2020-12, or null).
Invalid schemas, and default payloads that violate their own schema, are rejected with `400`.
`GET …/jobs?queue=emails` filters by queue.

### Monitoring and cancellation

* `GET …/executions?trigger=QUEUE&queue=emails&delayed=true`. Every execution has `queue`,
  `priority` and `delayed`.
* SSE `execution.updated` events carry `queue`, `priority` and `delayed`.
* `POST …/executions/:id/cancel`:
  * not-yet-started executions (pending, delayed, queued, waiting for a retry) are cancelled for good, and a queued BullMQ delivery is removed
  * running executions get a best-effort abort signal
  * agent tokens may cancel only executions that have not started (`409` otherwise)

## Semantics

* **Durability.** A submission is a PostgreSQL row before the API answers. Delays are timed by
  PostgreSQL, not by Redis, so delayed jobs survive a Redis restart or flush and can be listed and
  cancelled.
* **Admission.** The dispatcher admits due executions while the queue is not paused, the queue has a
  free slot, and the job has a free slot (`maxConcurrency`, or 1 for `concurrencyPolicy: FORBID`). A
  slot is held from `QUEUED` until the attempt finishes, so executors never receive more than the
  limits allow. This holds across any number of scheduler replicas.
* **Order.** Within a queue, executions are admitted by priority (higher first), then by due
  time. A queue at its limit never blocks other queues. Priority applies to waiting work: it
  does not pre-empt running executions.
* **Latency.**
  * Immediate submissions wake the dispatcher through Redis and start within milliseconds.
  * If the wake-up is lost, the next scheduler tick (`CHRONOS_SCHEDULER_TICK_MS`, default 1 s) dispatches them.
  * Delayed jobs start within one tick of their time.
* **Retries.** Each execution has its own `maxAttempts` and backoff, copied from the job unless
  overridden. Exhausted retries end in `DEAD_LETTERED`, and replay is possible.
* **Idempotency.** Keys are unique per job and shared by manual triggers and queue submissions. A key
  stays reserved as long as its execution exists, which is `CHRONOS_EXECUTION_RETENTION_DAYS` after
  it finishes.
* **FORBID.**
  * A scheduled occurrence is skipped while another run is active.
  * A manual trigger gets `409`.
  * A queue submission is accepted and waits for its turn.
* **At-least-once.** As with scheduled jobs, a handler can run more than once for the same
  execution after a crash or network partition. Use `ctx.idempotencyKey`.
