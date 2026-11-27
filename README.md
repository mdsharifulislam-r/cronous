# Chronos

[![CI](https://github.com/mdsharifulislam-r/cronous/actions/workflows/ci.yml/badge.svg)](https://github.com/mdsharifulislam-r/cronous/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

Self-hosted, distributed job scheduling and execution platform.

> **Status: pre-1.0.** APIs and the database schema may still change between minor versions;
> migrations are provided. See [CHANGELOG.md](CHANGELOG.md).

Chronos centralizes scheduling. Your applications declare jobs; the Chronos server
decides when they run, dispatches them, tracks every attempt durably in PostgreSQL,
retries failures with backoff, and recovers from crashed workers, agents and schedulers.
Delivery is **at-least-once**, so make handlers idempotent (every execution carries a
stable `idempotencyKey`).

## Execution modes

| Mode | How it runs | Use when |
| --- | --- | --- |
| **HTTP webhook** | Chronos calls your endpoint (signed, with timeouts, retries and SSRF protection) | Your app already exposes HTTP endpoints |
| **Agent** | Your app runs `@cronouss/cronous`, which keeps an **outbound** WebSocket and runs handlers in-process | Code should run inside your app, which has no public inbound port |
| **Central worker** | Chronos worker processes run handler modules you mount | Jobs should run independently of your app servers |

## Quick start (Docker, bundled PostgreSQL + Redis)

No checkout or build needed. Chronos is published as container images for `linux/amd64` and
`linux/arm64`:

| Image | Contents |
| --- | --- |
| `cronouss/cronous` | API server, scheduler, worker and migrations |
| `cronouss/cronous-dashboard` | Web dashboard (optional) |

```bash
mkdir chronos && cd chronos
curl -fsSLO https://github.com/mdsharifulislam-r/cronous/releases/latest/download/compose.yaml
curl -fsSL  https://github.com/mdsharifulislam-r/cronous/releases/latest/download/env.example -o .env
# edit .env: set POSTGRES_PASSWORD and REDIS_PASSWORD (openssl rand -hex 32)
docker compose up -d                               # add --profile dashboard for the full dashboard
docker compose logs server | grep -A2 "bootstrap token"
```

Already running PostgreSQL and Redis? Use the server image directly:

```bash
docker run -d --name chronos -p 127.0.0.1:8080:8080 \
  -e DATABASE_URL=postgresql://chronos:PASSWORD@db-host:5432/chronos \
  -e REDIS_URL=redis://:PASSWORD@redis-host:6379/0 \
  -e CHRONOS_MIGRATE_ON_START=true \
  cronouss/cronous:latest
```

Bootstrap once with that token (creates the admin, organization, project, a project API
key and an agent token):

```bash
curl -sS -X POST http://127.0.0.1:8080/v1/bootstrap \
  -H "Authorization: Bearer $BOOTSTRAP_TOKEN" -H 'Content-Type: application/json' \
  -d '{"admin":{"email":"you@example.com","name":"You","password":"a-long-passphrase"},
       "organization":{"name":"Acme","slug":"acme"},
       "project":{"name":"Storefront","slug":"storefront","timezone":"Asia/Dhaka"}}'
```

Open the built-in dashboard at <http://127.0.0.1:8080/dashboard/>, or start the full dashboard
with `--profile dashboard` (<http://127.0.0.1:3000>, see [apps/dashboard](apps/dashboard)). See
[docs/DEPLOYMENT_GUIDE.md](docs/DEPLOYMENT_GUIDE.md) for existing infrastructure, shared Docker
networks, separate VPSs, workers and scaling.

## Node.js SDK

```bash
npm install @cronouss/cronous
```

One package for workers (run handlers in your app), producers (submit immediate and delayed
jobs) and an admin client (manage jobs, schedules, queues and executions from code). Full
guide: [packages/sdk/README.md](packages/sdk/README.md).

```ts
// src/config/chronos.ts
import { Chronos } from '@cronouss/cronous';

export const chronos = new Chronos({
  server: process.env.CHRONOS_SERVER!,   // e.g. https://chronos.example.com
  project: 'storefront',
  timezone: 'Asia/Dhaka',
  // token defaults to process.env.CHRONOS_AGENT_TOKEN (chr_a_...)
});
```

```ts
// src/modules/reports/report.jobs.ts
import { chronos } from '../../config/chronos';

chronos.task('daily-report', { schedule: '0 2 * * *', timezone: 'Asia/Dhaka' }, async (ctx) => {
  ctx.log.info('Generating daily report...');
  // ctx: executionId, attempt, scheduledFor, idempotencyKey, payload, signal, log
});
```

```ts
// src/main.ts
import { chronos } from './config/chronos';
import './modules/reports/report.jobs';
import './modules/users/user.jobs';

async function bootstrap() {
  await chronos.start();                  // syncs tasks, then receives executions
  process.once('SIGTERM', () => void chronos.stop());   // finishes running handlers first
}
bootstrap();
```

Submit jobs for immediate or delayed execution from any application of the project. These
are not cron expressions; see [docs/QUEUE_JOBS.md](docs/QUEUE_JOBS.md):

```ts
await chronos.queue('send-email', { to: 'a@example.com' });
await chronos.queue('send-reminder', { userId: 7 }, { delay: 300_000, priority: 80, idempotencyKey: 'reminder-7' });
```

Task options: `schedule` (5-field cron) or `runAt`, `timezone`, `misfirePolicy`
(`FIRE_ONCE` | `SKIP` | `FIRE_ALL`), `misfireGraceMs`, `maxCatchUp`, `timeoutMs`,
`maxAttempts`, `retryBackoffMs`, `retryBackoffMaxMs`, `concurrencyPolicy`
(`ALLOW` | `FORBID`), `queue`, `priority`, `maxConcurrency`, `payloadSchema`. Throw `NonRetryableError` for permanent failures. Tasks without a
schedule run when triggered from the API or dashboard. A complete example lives in
[examples/sdk-app](examples/sdk-app).

Manage Chronos from code with a project API key (`chr_p_`):

```ts
import { ChronosAdmin } from '@cronouss/cronous';

const admin = new ChronosAdmin({ server: process.env.CHRONOS_SERVER!, project: 'storefront' }); // token: CHRONOS_API_KEY
await admin.jobs.create({ name: 'sync-crm', mode: 'HTTP', http: { url: 'https://app.example.com/hooks/sync', method: 'POST' }, schedule: { cron: '*/15 * * * *' } });
const run = await admin.jobs.trigger('daily-report');
const done = await admin.executions.wait(run.id);              // SUCCEEDED, FAILED, …
for await (const failed of admin.executions.iterate({ status: 'DEAD_LETTERED' })) await admin.executions.retry(failed.id);
await admin.queues.pause('emails');
```

## HTTP webhook and worker jobs

```bash
curl -sS -X POST http://127.0.0.1:8080/v1/projects/$PROJECT_ID/jobs \
  -H "Authorization: Bearer $PROJECT_KEY" -H 'Content-Type: application/json' \
  -d '{"name":"nightly-sync","mode":"HTTP",
       "http":{"url":"https://app.example.com/jobs/sync","method":"POST","signingSecret":"…16+ chars…"},
       "schedule":{"cron":"30 1 * * *","timezone":"Asia/Dhaka"},
       "maxAttempts":5,"timeoutMs":60000}'
```

Mode C (`"mode":"WORKER"`) runs the handler of the same name from the module mounted into
the worker container (see [apps/worker/examples/handlers.js](apps/worker/examples/handlers.js)).

## Repository layout

```
apps/server        NestJS API, agent gateway, dashboard hosting, embedded scheduler + webhook worker
apps/scheduler     standalone scheduler process
apps/worker        standalone worker process (Mode C handlers, webhooks)
apps/dashboard     Next.js dashboard (full UI)
apps/dashboard-lite  bundled static UI served by the server at /dashboard
packages/engine    scheduler, dispatcher, execution state machine, reaper, webhook executor, worker runtime
packages/protocol  versioned agent protocol + job definition schemas
packages/sdk       @cronouss/cronous
packages/database  Prisma schema, migrations, seed
packages/shared    env validation, crypto, Redis keyspace, cron/timezone planner
examples/sdk-app   example application
docker/            Dockerfile and compose files
docs/              architecture and deployment
```

Documentation:

* [docs/architecture.md](docs/architecture.md): design decisions, reliability model, known limitations
* [docs/DEPLOYMENT_GUIDE.md](docs/DEPLOYMENT_GUIDE.md) and [docs/ENVIRONMENT_CONFIGURATION.md](docs/ENVIRONMENT_CONFIGURATION.md)
* [docs/API_REFERENCE.md](docs/API_REFERENCE.md) and [docs/WEBSOCKET_PROTOCOL.md](docs/WEBSOCKET_PROTOCOL.md)
* [docs/QUEUE_JOBS.md](docs/QUEUE_JOBS.md): scheduled, immediate and delayed jobs; queues; SDK and REST contracts
* [docs/DASHBOARD_INTEGRATION.md](docs/DASHBOARD_INTEGRATION.md): building a dashboard on the API
* [docs/BACKEND_AUDIT.md](docs/BACKEND_AUDIT.md): latest backend audit and dashboard readiness

## Development

Requires Node.js ≥ 22.12, pnpm 9 (`corepack enable`) and Docker.

```bash
pnpm install
pnpm build
pnpm infra:test:up                     # PostgreSQL :55432, Redis :56379 (localhost only)
cp .env.example .env                   # for local dev set e.g.:
#   NODE_ENV=development LOG_PRETTY=true
#   DATABASE_URL=postgresql://chronos:chronos@127.0.0.1:55432/chronos_dev
#   REDIS_URL=redis://127.0.0.1:56379/1
DATABASE_URL=postgresql://chronos:chronos@127.0.0.1:55432/chronos_dev pnpm db:migrate
pnpm dev                               # server in watch mode; prints the bootstrap token
```

On Windows, prefer `127.0.0.1` over `localhost` in connection URLs: `localhost` tries
IPv6 first, which adds about 2s to every new connection.

## Testing

```bash
pnpm typecheck
pnpm test                              # unit tests
pnpm infra:test:up && pnpm test:integration   # real PostgreSQL + Redis; fails (never skips) without them
pnpm infra:test:down
```

The integration suite covers bootstrap, auth and RBAC, credentials, concurrent scheduler
replicas, misfire policies, the outbox, SDK agents over real WebSockets (sync,
execution, retries, timeouts, reconnection, cancellation, graceful shutdown, recovery
after an agent vanishes), workers (concurrency limits, duplicate deliveries, crash
recovery, hard timeouts), webhook delivery (signing, retry classification, timeouts,
SSRF) and the dashboard.

## API overview (v1)

| Area | Endpoints |
| --- | --- |
| Health | `GET /health/live`, `GET /health/ready`, `GET /v1/system` |
| Bootstrap | `GET /v1/bootstrap/status`, `POST /v1/bootstrap` |
| Auth | `POST /v1/auth/login`, `POST /v1/auth/logout`, `GET/PATCH /v1/auth/me`, `POST /v1/auth/password` |
| Organizations | `POST/GET /v1/organizations`, `GET/PATCH/DELETE /v1/organizations/:orgId`, members under `/members`, `GET …/audit-logs` |
| Projects | `GET/POST /v1/organizations/:orgId/projects`, `GET/PATCH/DELETE /v1/projects/:projectId` |
| Credentials | `GET/POST /v1/projects/:projectId/credentials`, `POST …/:id/rotate`, `DELETE …/:id` |
| Jobs | `GET/POST /v1/projects/:projectId/jobs`, `GET/PATCH/DELETE …/:jobId`, `POST …/pause`, `…/resume`, `…/trigger`, `GET …/schedule/preview` |
| Schedules | `POST /v1/projects/:projectId/schedule/preview`, `GET …/schedule/upcoming` |
| Queue jobs | `POST /v1/projects/:projectId/queue`, `POST …/queue/batch`, `GET/POST /v1/projects/:projectId/queues`, `GET/PATCH/DELETE …/queues/:name`, `POST …/queues/:name/pause`, `…/resume` |
| Executions | `GET /v1/projects/:projectId/executions`, `GET …/:id`, `GET …/:id/logs`, `POST …/:id/cancel`, `POST …/:id/retry`, `GET /v1/projects/:projectId/stats`, `GET …/stats/timeseries` |
| Executors | `GET /v1/projects/:projectId/agents`, `GET/DELETE …/agents/:agentId`, `GET /v1/workers` |
| Real-time | `GET /v1/projects/:projectId/events` (Server-Sent Events for dashboards) |
| Agent protocol | `GET /v1/agent/ws` (WebSocket, agent token) |

Responses use `{ data, meta }` or `{ error, meta }` envelopes and carry `X-Request-Id`.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup and
the checks every pull request runs, and follow the [code of conduct](CODE_OF_CONDUCT.md).
Report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

Chronos is licensed under the [Apache License 2.0](LICENSE).
