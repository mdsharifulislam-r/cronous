# Environment configuration

Every process validates its environment at startup with Zod and refuses to start on invalid
values. It prints every problem at once. Sources:
- `apps/server/src/config/env.schema.ts`
- `packages/engine/src/host.ts` (`baseProcessEnvSchema`)
- `apps/scheduler/src/main.ts`
- `apps/worker/src/main.ts`

With Docker Compose, variables go from `.env` (`--env-file .env`) to the containers through
an **explicit list** in `docker/compose*.yaml`. A variable missing from that list has no effect
inside the container. Every server variable below is forwarded.

Booleans accept `true/false/1/0/yes/no`. Durations are milliseconds unless the name says otherwise.

## Server (`apps/server`, the `server` container)

### Core

| Variable | Default | Valid | Meaning |
| --- | --- | --- | --- |
| `NODE_ENV` | `development` | development, test, production | Compose sets `production` |
| `HOST` | `0.0.0.0` | | Listen address |
| `PORT` | `8080` | 1–65535 | Listen port |
| `LOG_LEVEL` | `info` | fatal…trace, silent | Pino level |
| `LOG_PRETTY` | `false` | | Human-readable logs; **must be false in production** |
| `DATABASE_URL` | – (required) | `postgres://` or `postgresql://` | PostgreSQL (verified with 17). Percent-encode special characters in the password |
| `REDIS_URL` | – (required) | `redis://` or `rediss://` | Redis (verified with 7.4), `maxmemory-policy noeviction` required |
| `CHRONOS_NAMESPACE` | `chronos` | `^[a-z][a-z0-9_-]{0,31}$` | Prefix for all Redis keys and BullMQ queues; lets Chronos share a Redis instance |

### Authentication and security

| Variable | Default | Valid | Meaning |
| --- | --- | --- | --- |
| `CHRONOS_BOOTSTRAP_TOKEN` | generated | 32–256 chars | One-time setup token. If unset, one is generated and printed once at first start |
| `CHRONOS_USER_TOKEN_TTL_HOURS` | `12` | 1–720 | Lifetime of login sessions |
| `CHRONOS_LOGIN_MAX_FAILURES` | `10` | 1–1000 | Failed logins or password changes per email before lockout |
| `CHRONOS_LOGIN_LOCKOUT_SECONDS` | `900` | 10–86400 | Lockout window |
| `CHRONOS_RATE_LIMIT_ENABLED` | `true` | | Per-minute API limits kept in Redis (shared by replicas). Health probes and the agent WebSocket are never limited |
| `CHRONOS_RATE_LIMIT_PER_TOKEN_PER_MINUTE` | `1200` | 1–1000000 | Requests per bearer token (user session, project key, agent token) |
| `CHRONOS_RATE_LIMIT_ANONYMOUS_PER_MINUTE` | `120` | 1–1000000 | Requests without a token per client IP (login, bootstrap) |
| `CHRONOS_RATE_LIMIT_AUTH_FAILURES_PER_MINUTE` | `30` | 1–100000 | Unknown tokens per client IP before that IP's requests are refused for the rest of the minute. Expired or revoked tokens do not count |
| `CHRONOS_CREDENTIAL_RECHECK_MS` | `30000` | 1000–600000 | How often open agent WebSockets and event streams re-validate their credential |
| `CHRONOS_TRUST_PROXY` | `false` | | Trust `X-Forwarded-*` (client IPs in the audit log). Enable only behind your own proxy |
| `CHRONOS_CORS_ORIGINS` | empty | comma list of exact origins | Browser origins allowed to call the API directly |

### Scheduling and execution

| Variable | Default | Valid | Meaning |
| --- | --- | --- | --- |
| `CHRONOS_EMBEDDED_SCHEDULER` | `true` | | Run the scheduler, dispatcher and reaper loop in this process |
| `CHRONOS_EMBEDDED_WORKER` | `true` | | Deliver HTTP webhooks from this process |
| `CHRONOS_SCHEDULER_TICK_MS` | `1000` | 100–60000 | Scheduler loop interval |
| `CHRONOS_LEASE_MS` | `30000` | 5000–600000 | Execution lease; executors renew at a third of it |
| `CHRONOS_WORKER_CONCURRENCY` | `10` | 1–1000 | Parallel webhook deliveries of the embedded worker |
| `CHRONOS_AGENT_HEARTBEAT_MS` | `10000` | 1000–120000 | SDK heartbeat interval sent in `welcome`; 3 missed intervals drop the socket |
| `CHRONOS_EXECUTION_RETENTION_DAYS` | `30` | 0–3650 | Finished executions older than this are deleted (0 = keep forever) |
| `CHRONOS_WEBHOOK_ALLOW_PRIVATE` | `true` | | Allow webhook targets in private ranges (10/8, 172.16/12, 192.168/16, fc00::/7) |
| `CHRONOS_WEBHOOK_ALLOWED_CIDRS` | empty | comma list of CIDRs | Always-allowed ranges; the only way to reach loopback or link-local |

### Dashboard support

| Variable | Default | Valid | Meaning |
| --- | --- | --- | --- |
| `CHRONOS_DASHBOARD_ENABLED` | `true` | | Serve the bundled UI at `/dashboard` |
| `CHRONOS_EVENTS_POLL_MS` | `1000` | 250–60000 | Change-feed poll interval for `GET /v1/projects/:id/events` (runs only while streams are open) |
| `CHRONOS_EVENTS_MAX_STREAMS` | `500` | 1–100000 | Concurrent event streams per server process (`503` above) |

### Process lifecycle

| Variable | Default | Valid | Meaning |
| --- | --- | --- | --- |
| `CHRONOS_SHUTDOWN_TIMEOUT_MS` | `15000` | 1000–300000 | Forced exit if graceful shutdown takes longer |
| `CHRONOS_READINESS_TIMEOUT_MS` | `2000` | 100–30000 | Per-dependency timeout of `/health/ready` |

## Standalone scheduler (`bin/scheduler/main.js`, compose profile `scale`)

These are the shared process variables: `NODE_ENV`, `LOG_LEVEL`, `LOG_PRETTY`, `DATABASE_URL`, `REDIS_URL`,
`CHRONOS_NAMESPACE`, `CHRONOS_HEALTH_PORT` (`8081`), and
`CHRONOS_SHUTDOWN_TIMEOUT_MS` (`30000`). The scheduler also reads `CHRONOS_SCHEDULER_TICK_MS`,
`CHRONOS_EXECUTION_RETENTION_DAYS` and `CHRONOS_AGENT_HEARTBEAT_MS`, with the same meanings as on the
server.

## Worker (`bin/worker/main.js`, compose profile `workers`)

The worker takes the shared process variables above, plus:

| Variable | Default | Meaning |
| --- | --- | --- |
| `CHRONOS_WORKER_MODES` | `WORKER` | Queues to consume: `WORKER`, `HTTP` or `HTTP,WORKER` |
| `CHRONOS_WORKER_CONCURRENCY` | `10` | Parallel executions per queue |
| `CHRONOS_WORKER_HANDLERS` | – | Path to the handler module (required for `WORKER` mode) |
| `CHRONOS_LEASE_MS` | `30000` | Must match the server |
| `CHRONOS_WEBHOOK_ALLOW_PRIVATE`, `CHRONOS_WEBHOOK_ALLOWED_CIDRS` | as server | Used when consuming `HTTP` |

## Container image

| Variable | Default | Meaning |
| --- | --- | --- |
| `CHRONOS_MIGRATE_ON_START` | `false` | Apply pending database migrations before the command starts (for single `docker run` setups; compose uses its `migrate` service). Safe with several replicas |

## Docker Compose only

| Variable | Default | Meaning |
| --- | --- | --- |
| `POSTGRES_USER`, `POSTGRES_DB` | `chronos` | Bundled PostgreSQL (compose.yaml) |
| `POSTGRES_PASSWORD`, `REDIS_PASSWORD` | – (required) | Bundled PostgreSQL and Redis; use `openssl rand -hex 32` |
| `CHRONOS_VERSION` | `latest` (a release's own compose file: that release) | Image tag to run, e.g. `0.1.0` |
| `CHRONOS_IMAGE`, `CHRONOS_DASHBOARD_IMAGE` | `cronouss/cronous`, `cronouss/cronous-dashboard` | Image names, for a mirror or private registry |
| `CHRONOS_HTTP_BIND` | `127.0.0.1` | Host interface the API is published on |
| `CHRONOS_HTTP_PORT` | `8080` | Host port |
| `CHRONOS_WORKER_HANDLERS_DIR` | `./handlers` (next to the compose file) | Host directory mounted read-only at `/handlers` |
| `CHRONOS_WORKER_HANDLERS_FILE` | `handlers.js` | File in that directory |
| `CHRONOS_EXTERNAL_NETWORK` | – | Existing Docker network to join (compose.network.yaml) |

## SDK (`@cronous/cronous`, in your application)

| Variable | Meaning |
| --- | --- |
| `CHRONOS_AGENT_TOKEN` | Agent token, used when `token` is not passed to `new Chronos()` |
| `CHRONOS_SERVER` | Conventional name for the `server` option (read by your code, not by the SDK) |
| `CHRONOS_DEBUG=1` | Debug logging with the default console logger |

## Next.js dashboard (`apps/dashboard`, compose profile `dashboard`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `CHRONOS_API_URL` | – (required) | Chronos API base URL as seen from the dashboard server, without `/v1` (compose: `http://server:8080`) |
| `DASHBOARD_SECURE_COOKIES` | `true` in production | `Secure` flag of the session cookie. Set it to `false` only for plain HTTP on a non-localhost host |
| `CHRONOS_PUBLIC_URL` | – | Public API URL shown in SDK snippets (read at runtime) |
| `CHRONOS_DASHBOARD_BIND`, `CHRONOS_DASHBOARD_PORT` | `127.0.0.1`, `3000` | Compose only: where the dashboard is published |

The browser never calls the API directly, so `CHRONOS_CORS_ORIGINS` is not needed for it.

## Tests

The integration tests use `docker/compose.test.yaml`: PostgreSQL on `127.0.0.1:55432`
(chronos/chronos) and Redis on `127.0.0.1:56379`. The URLs can be overridden with
`CHRONOS_TEST_DATABASE_URL` and `CHRONOS_TEST_REDIS_URL` (see `apps/server/test/setup/test-env.ts`).
