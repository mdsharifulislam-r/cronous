# Chronos

**Self-hosted, distributed job scheduler.** Run cron and one-time schedules, immediate and
delayed background jobs, and queues with retries. Every attempt is tracked durably in
PostgreSQL, and crashed workers are recovered.

This image contains the **API server, scheduler, worker and database migrations**. The
optional web dashboard is [`cronouss/cronous-dashboard`](https://hub.docker.com/r/cronouss/cronous-dashboard).

* Source, docs and issues: <https://github.com/mdsharifulislam-r/cronous>
* Node.js SDK: [`@cronous/cronous`](https://www.npmjs.com/package/@cronous/cronous)
* License: Apache-2.0

## Tags

| Tag | Meaning |
| --- | --- |
| `latest` | Newest release |
| `0.1`, `0.1.1`, … | A minor line, or an exact version (recommended for production) |

Images are built for **linux/amd64** and **linux/arm64**.

## What it does

* **Schedules:** 5-field cron or one-time `runAt`, time zones and DST, misfire policies, overlap control
* **Queue jobs:** run now or after a delay, with priorities, per-queue and per-job concurrency limits, pause/resume, JSON Schema payload validation
* **Three ways to run a job:**
  * **HTTP webhook:** Chronos calls your endpoint, signed and SSRF-protected
  * **Agent:** your app runs the handler through the SDK over an outbound WebSocket
  * **Central worker:** this image runs handler modules you mount
* **Reliability:** retries with exponential backoff, dead letters and replay, leases with fencing, and recovery from crashes. Delivery is at least once.
* **API:** REST API with organizations, projects, roles, revocable credentials, an audit log, statistics and Server-Sent Events

## How it works

Chronos is a **task queue and scheduler**. Something says "run this job", Chronos stores it,
decides when it runs, hands it to exactly one handler, and retries it if it fails.

### Concepts

| Term | Meaning |
| --- | --- |
| **Job** | A named unit of work, e.g. `send-email`. It has a mode, retry settings and an optional cron schedule. |
| **Execution** | One run of a job, with its own payload, status, attempts and logs. |
| **Producer** | Anything that submits an execution: `chronos.queue()`, the REST API, the dashboard, or the job's own cron schedule. |
| **Handler** | The code that does the work: a `chronos.task()` function in your app, your HTTP endpoint, or a central worker. |
| **Queue** | A lane with a concurrency limit and priorities. It can be paused. Every job belongs to one queue (`default` unless set). |

### Lifecycle of an execution

```
 producer                     Chronos (PostgreSQL + Redis)                  handler
 ────────                     ────────────────────────────                  ───────
 queue('send-email', data) ─► 1. stored durably ............ PENDING
 or a cron schedule fires     2. waits for its time if delayed
                              3. admitted by its queue
                                 (concurrency, priority) ... QUEUED
                              4. delivered by job mode ─────────────────►  AGENT:  your app's chronos.task()
                                                                           HTTP:   POST to your endpoint
                                                                           WORKER: Chronos worker container
                              5. handler runs ............... RUNNING  ◄──  logs, heartbeat
                              6. result stored .............. SUCCEEDED
                                 on failure: retry with backoff (RETRY_SCHEDULED),
                                 after the last attempt ...... DEAD_LETTERED (replayable)
```

### Example: one service produces, another consumes

```ts
// email-service (consumer): keep this process running
import { Chronos } from '@cronous/cronous';
const chronos = new Chronos({ server: 'http://chronos:8080', project: 'storefront' }); // CHRONOS_AGENT_TOKEN

chronos.task('order.send-email', async ({ payload, idempotencyKey }) => {
  await sendOrderEmail(payload.orderId, payload.email);   // return = success, throw = retry
});
await chronos.start();
```

```ts
// order-service (producer): no start() needed, queue() is a single HTTP call
import { Chronos } from '@cronous/cronous';
const chronos = new Chronos({ server: 'http://chronos:8080', project: 'storefront' });

await chronos.queue('order.send-email', { orderId: 42, email: 'a@example.com' });           // now
await chronos.queue('order.send-email', { orderId: 42, email: 'a@example.com' }, { delay: 60_000 }); // in 1 minute
```

Producers from other languages use the REST API:
`POST /v1/projects/:projectId/queue` with `{"job":"order.send-email","payload":{…},"delayMs":60000}`
and a project API key.

What you can rely on:

* **The job must exist.** A worker's `chronos.task('order.send-email')` creates it when the worker
  connects. You can also create it through the API or the dashboard. `queue()` with an unknown
  name fails with `ChronosNotFoundError`.
* **Nothing is lost while consumers are offline.** Executions wait in PostgreSQL until a handler
  connects.
* **Scale by running more copies.** Start three instances of the email-service and executions
  are shared between them. Each execution goes to **one** instance.
* **Failures are retried** with exponential backoff (`maxAttempts`, `backoff`). Throw
  `NonRetryableError` to stop retrying. Exhausted executions become dead letters that you can
  replay from the dashboard or the API.
* **At-least-once delivery.** After a crash or network split a handler can run twice, so use
  `ctx.idempotencyKey` for side effects.

### Compared with Kafka and other message brokers

| Kafka | Chronos |
| --- | --- |
| `producer.send({ topic })` | `chronos.queue('job-name', payload)` |
| Topic | Job name |
| `consumer.subscribe()` + `eachMessage` | `chronos.task('job-name', handler)` |
| Consumer group, with partitions shared | Several instances of the same task, with executions shared |
| Commit the offset | Return from the handler |
| Build retries and DLQs yourself | Retries, backoff, delays, cron, dead letters, a dashboard and per-execution history are built in |

The key difference: **Chronos does not broadcast.** In Kafka every consumer group receives every
message (pub/sub). In Chronos an execution runs **once, in one handler**, like a work queue.
To trigger several kinds of work from one event, submit one job per kind of work:

```ts
await chronos.queue('order.send-email', order);     // handled by email-service
await chronos.queue('order.update-stock', order);   // handled by inventory-service
await chronos.queue('order.track', order);          // handled by analytics-service
```

Use Kafka for event streams that many services read and replay. Use Chronos for work that
must be done, possibly later or on a schedule, with retries and visibility. Many systems
use both: a Kafka consumer calls `chronos.queue()`.

## Docker Compose

Save this as `compose.yaml`. It runs Chronos with PostgreSQL, Redis and the web dashboard:

```yaml
services:
  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: chronos
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
      POSTGRES_DB: chronos
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U chronos -d chronos"]
      interval: 5s
      timeout: 3s
      retries: 20

  redis:
    image: redis:7.4-alpine
    restart: unless-stopped
    command: ["sh", "-c", "exec redis-server --appendonly yes --maxmemory-policy noeviction --requirepass \"$$REDIS_PASSWORD\""]
    environment:
      REDIS_PASSWORD: ${REDIS_PASSWORD:?set REDIS_PASSWORD in .env}
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD-SHELL", "redis-cli -a \"$$REDIS_PASSWORD\" --no-auth-warning ping | grep -q PONG"]
      interval: 5s
      timeout: 3s
      retries: 20

  chronos:
    image: cronouss/cronous:0.1.1
    restart: unless-stopped
    environment:
      DATABASE_URL: postgresql://chronos:${POSTGRES_PASSWORD}@postgres:5432/chronos
      REDIS_URL: redis://:${REDIS_PASSWORD}@redis:6379/0
      CHRONOS_MIGRATE_ON_START: "true"
    ports:
      - "127.0.0.1:8080:8080"
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy

  dashboard:
    image: cronouss/cronous-dashboard:0.1.1
    restart: unless-stopped
    environment:
      CHRONOS_API_URL: http://chronos:8080
    ports:
      - "127.0.0.1:3000:3000"
    depends_on:
      chronos:
        condition: service_healthy

volumes:
  postgres-data:
  redis-data:
```

Create a `.env` file next to it with two passwords (hex is URL-safe), then start the stack:

```bash
echo "POSTGRES_PASSWORD=$(openssl rand -hex 32)" >  .env
echo "REDIS_PASSWORD=$(openssl rand -hex 32)"    >> .env

docker compose up -d
docker compose logs chronos | grep -A2 "bootstrap token"
```

* API and built-in UI: <http://127.0.0.1:8080> (`/dashboard/`)
* Web dashboard: <http://127.0.0.1:3000>

### Add Chronos to an existing Compose project

If your `compose.yaml` already has PostgreSQL and Redis, add only this service. Create a
`chronos` database first, and make sure Redis uses `maxmemory-policy noeviction`:

```yaml
  chronos:
    image: cronouss/cronous:0.1.1
    restart: unless-stopped
    environment:
      DATABASE_URL: postgresql://chronos:PASSWORD@postgres:5432/chronos
      REDIS_URL: redis://:PASSWORD@redis:6379/3
      CHRONOS_MIGRATE_ON_START: "true"
    ports:
      - "127.0.0.1:8080:8080"
    depends_on:
      - postgres
      - redis
```

Your other services reach it at `http://chronos:8080`.

The full compose file from the releases also includes optional workers and a standalone
scheduler:
`curl -fsSLO https://github.com/mdsharifulislam-r/cronous/releases/latest/download/compose.yaml`

## Quick start: your own PostgreSQL and Redis

```bash
docker run -d --name chronos --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -e DATABASE_URL=postgresql://chronos:PASSWORD@db-host:5432/chronos \
  -e REDIS_URL=redis://:PASSWORD@redis-host:6379/0 \
  -e CHRONOS_MIGRATE_ON_START=true \
  cronouss/cronous:latest
```

Requirements: PostgreSQL 17 and Redis 7.4 (verified). Redis must use
`maxmemory-policy noeviction`. Chronos prefixes all its Redis keys, so it can share a Redis
instance with your applications.

## First-time setup

On first start, the server prints a one-time **bootstrap token** in its log (`docker logs chronos`).
Use it once to create the admin user, organization and first project:

```bash
curl -sS -X POST http://127.0.0.1:8080/v1/bootstrap \
  -H "Authorization: Bearer $BOOTSTRAP_TOKEN" -H 'Content-Type: application/json' \
  -d '{"admin":{"email":"you@example.com","name":"You","password":"a-long-passphrase"},
       "organization":{"name":"Acme","slug":"acme"},
       "project":{"name":"Storefront","slug":"storefront","timezone":"UTC"}}'
```

The response contains a **project API key** (`chr_p_…`) and an **agent token** (`chr_a_…`).
They are shown only once, so store them safely. You can also open the built-in UI at
`http://127.0.0.1:8080/dashboard/`.

## Commands

The same image runs every role:

| Command | Role |
| --- | --- |
| *(default)* `node dist/main.js` | API server, with the scheduler and webhook worker embedded |
| `node bin/scheduler/main.js` | Standalone scheduler (set `CHRONOS_EMBEDDED_SCHEDULER=false` on the server) |
| `node bin/worker/main.js` | Central worker running your mounted handlers (`CHRONOS_WORKER_HANDLERS=/handlers/handlers.js`) |
| `/app/bin/migrate` | Apply database migrations and exit |

## Main environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `DATABASE_URL` | required | PostgreSQL connection URL |
| `REDIS_URL` | required | Redis connection URL (`rediss://` for TLS) |
| `CHRONOS_MIGRATE_ON_START` | `false` | Apply pending migrations before starting (safe with several replicas) |
| `CHRONOS_BOOTSTRAP_TOKEN` | generated | Set your own one-time setup token instead of reading it from the log |
| `CHRONOS_NAMESPACE` | `chronos` | Prefix for Redis keys and queues |
| `PORT` | `8080` | Listen port |
| `LOG_LEVEL` | `info` | `fatal` … `trace` |
| `CHRONOS_TRUST_PROXY` | `false` | Enable only behind your own reverse proxy |
| `CHRONOS_CORS_ORIGINS` | empty | Browser origins allowed to call the API directly |
| `CHRONOS_EMBEDDED_SCHEDULER` / `CHRONOS_EMBEDDED_WORKER` | `true` | Run scheduling and webhook delivery inside the server |
| `CHRONOS_WORKER_CONCURRENCY` | `10` | Parallel executions per worker |
| `CHRONOS_EXECUTION_RETENTION_DAYS` | `30` | How long finished executions are kept |

All variables are listed in the
[environment reference](https://github.com/mdsharifulislam-r/cronous/blob/main/docs/ENVIRONMENT_CONFIGURATION.md).

## Health checks

* `GET /health/live`: the process is up
* `GET /health/ready`: PostgreSQL and Redis are reachable (`503` otherwise)

The image has a built-in `HEALTHCHECK`, runs as the unprivileged `node` user, uses `tini` as
init, and stops gracefully on `SIGTERM`.

## Use it from your application (Node.js)

```bash
npm install @cronous/cronous
```

```ts
import { Chronos } from '@cronous/cronous';

const chronos = new Chronos({ server: 'https://chronos.example.com', project: 'storefront' }); // CHRONOS_AGENT_TOKEN
chronos.task('daily-report', { schedule: '0 2 * * *' }, async (ctx) => { /* … */ });
await chronos.start();

await chronos.queue('send-email', { to: 'a@example.com' }, { delay: 60_000 });
```

## Production notes

* Keep the API on `127.0.0.1` or a private network. Put a TLS reverse proxy in front before you expose it.
* Pin an exact version tag, and back up PostgreSQL: it holds all definitions, history and credentials.
* See the [deployment guide](https://github.com/mdsharifulislam-r/cronous/blob/main/docs/DEPLOYMENT_GUIDE.md) for topologies, scaling and upgrades.
