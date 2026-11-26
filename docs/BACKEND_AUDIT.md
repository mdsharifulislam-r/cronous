# Chronos backend audit and dashboard readiness

Date: 2026-11-26 · Scope: the whole monorepo (`apps/*`, `packages/*`, `docker/`, docs) ·
Method: reading the implementations (not file names), running every available check
against real PostgreSQL 17 and Redis 7.4, an end-to-end run on the Docker Compose stack,
and fixing what was broken or missing.

## 1. Verdict

**READY WITH MINOR LIMITATIONS.**

Every page the dashboard needs has implemented endpoints, and all of them pass integration tests against real
infrastructure, including the new real-time stream. The limitations in §9 are deliberate scope
boundaries or operational caveats. None of them blocks building the dashboard. The verdict is not
an unconditional READY for three reasons:
- no linter is configured
- some deployment variants were only validated as configuration, not run
- a few dashboard conveniences are absent: job-list pagination, bulk actions, server-side sorting options

## 2. Verification performed

| Check | Command | Result |
| --- | --- | --- |
| Clean install | `pnpm install --frozen-lockfile` | Pass |
| Type check (all packages) | `pnpm typecheck` | Pass (16/16 tasks) |
| Build | `pnpm build` | Pass (10/10 tasks) |
| Unit tests | `pnpm test` | **78/78**: shared 25, protocol 4, sdk 6, engine 15, server 28 |
| Integration tests (PostgreSQL 17 + Redis 7.4) | `pnpm test:integration` | **86/86** in 7 files (68 before the audit; 18 new) |
| Migration drift | `prisma migrate diff --from-migrations … --to-schema-datamodel …` | No difference |
| Compose files | `docker compose config -q` for bundled, bundled+workers+scale, external, external+network, test | All valid |
| Docker e2e (bundled stack, image built from this tree) | scripted against `docker/compose.yaml --profile workers` | Both migrations applied and new indexes present. `.env` values reach the container. A cron `* * * * *` webhook fired by itself (`sched:` key) and SUCCEEDED. Connection-refused webhook: 3 attempts → DEAD_LETTERED, replay → PENDING. SDK agent job SUCCEEDED. Central worker job SUCCEEDED. Revoking the agent token disconnected the running SDK in 20 s (fatal close). 48 h calendar projection, time series, activity log, `no-store` headers OK. SSE delivered 15 events (ready, execution, agent). 0 error-level log lines in server and worker |

The e2e checks of `/v1/system`, `/stats`, `/schedule/preview` and the session TTL value did
not execute, because of a quoting bug in the e2e script's JSON helper, not in the server.
These endpoints are covered by the integration suite, and the TTL setting was confirmed inside
the container (`TTL=6`).

**Not performed, and therefore not claimed:**
- `pnpm lint`: the repository has **no lint script or ESLint configuration**. Static checking
  relies on TypeScript `strict` with `noUncheckedIndexedAccess`.
- Option B (external PostgreSQL and Redis) and the "existing Docker network" overlay: only
  validated with `docker compose config`. They were not run against a real external database.
- TLS, WSS and reverse-proxy behaviour (nginx/Caddy) were not exercised.
- Multiple server replicas behind a load balancer were not run in Docker. Multi-replica scheduling
  is covered by integration tests (several scheduler instances on one database), but cross-replica agent
  cancellation and event streams with several server processes are not.
- Load, soak and performance testing were not done.

## 3. Feature audit

Legend: **V** = implemented and verified by automated tests or e2e · **I** = implemented, not verified at
runtime · **P** = partial · **M** = missing.

| Area | Capability | Status | Evidence |
| --- | --- | --- | --- |
| Auth | Bootstrap (one-time token, concurrent attempts, invalid after use) | V | `bootstrap.int-spec`, e2e |
| | Login, logout, session expiry, lockout | V | `auth-rbac.int-spec` |
| | Project keys / agent tokens, rotation with grace, revocation | V | `auth-rbac.int-spec` |
| | Revocation disconnects **already-connected** agents | V (**fixed**) | `dashboard-api.int-spec`, e2e |
| | RBAC (roles, 404 for non-members, machine principals ≤ MEMBER) | V | `auth-rbac.int-spec`, `auth.guards.spec` |
| | Profile update, password change (revokes other sessions) | V (**added**) | `dashboard-api.int-spec` |
| Orgs/projects | CRUD, members, last-owner protection, archive revokes credentials | V | `auth-rbac.int-spec` |
| | Project isolation (cross-project ids return 404) | V | `auth-rbac.int-spec`, `dashboard-api.int-spec` |
| Jobs | CRUD, enable/disable, pause/resume, manual trigger with idempotency | V | `scheduler.int-spec` |
| | Validation (strict schemas, cron, IANA zones, HTTP config) | V | unit + integration |
| | Search / source filter | V (**added**) | `dashboard-api.int-spec` |
| | Masked webhook secrets survive an edit round-trip | V (**fixed**) | `http.spec`, `dashboard-api.int-spec` |
| Scheduling | Cron parsing, time zones, DST (gap and overlap) | V | `schedule.spec` |
| | Next-run calculation, one-time schedules | V | `schedule.spec`, `scheduler.int-spec` |
| | Misfire recovery (FIRE_ONCE / SKIP / FIRE_ALL) | V | `scheduler.int-spec` |
| | No duplicate scheduling with concurrent schedulers | V | `scheduler.int-spec` (5 replicas) |
| | Schedule update / removal / pause | V | `scheduler.int-spec` |
| | Fires on its own in Docker (no manual trigger) | V | e2e (every-minute cron) |
| | Unsaved-schedule preview, calendar projection | V (**added**) | `dashboard-api.int-spec`, e2e |
| Execution | HTTP webhook (signing, timeouts, retry classes, SSRF) | V | `worker.int-spec`, `http.spec`, e2e |
| | Agent execution (SDK) | V | `agent.int-spec`, e2e |
| | Central worker execution | V | `worker.int-spec`, e2e |
| | Ack, completion, failure reporting, result acks | V | `agent.int-spec` |
| | Retries with exponential backoff (+ jitter), dead letter, replay | V | integration, e2e |
| | Hard timeouts, abandoned-lease recovery | V | `worker.int-spec`, `agent.int-spec` |
| | Outbox: no lost dispatch between commit and enqueue | V | `scheduler.int-spec` |
| | History: list (filters, keyset pages), detail, log paging | V (**extended**) | integration |
| Agents | Registration, task sync, heartbeat, reconnection, disconnection detection | V | `agent.int-spec` |
| | Detail and removal of offline agents | V (**added**) | `dashboard-api.int-spec` |
| Workers | Registration, heartbeat, claiming, concurrency, failure, graceful shutdown | V | `worker.int-spec` |
| Infra | PostgreSQL, Prisma migrations, drift check | V | `prisma migrate diff` (no drift) |
| | Redis, BullMQ, namespace isolation | V | integration (separate namespace) |
| | Bundled Docker Compose | V | e2e |
| | External infrastructure, existing network | I | `docker compose config` only |
| | Health / readiness | V | `health.int-spec`, e2e |
| | Compose forwards all documented server variables | V (**fixed**) | e2e checks the values inside the container |
| Real-time | Dashboard event stream (SSE) | V (**added**) | `dashboard-api.int-spec`, e2e |
| | Activity log API | V (**added**) | `dashboard-api.int-spec`, e2e |

## 4. Issues found and fixed

| # | Severity | Issue | Fix |
| --- | --- | --- | --- |
| 1 | **High** | Agent WebSockets were authenticated only at upgrade. After an agent token was revoked, rotated past its grace period, or its project was archived, a **connected** agent kept claiming and running jobs until it reconnected (possibly days). | Sessions re-validate the credential every `CHRONOS_CREDENTIAL_RECHECK_MS` (default 30 s, on heartbeat and before claiming) and close with fatal code `4001`. Tested in integration and e2e. |
| 2 | **High** (data integrity) | Job responses mask secrets as `********`. A dashboard form sending the job back would have **saved the mask as the real bearer token, password or header**, silently breaking webhooks. | Masked values now restore the stored secret on create and update. A mask without a stored value returns `400`. |
| 3 | Medium | `docker/compose*.yaml` did not forward `CHRONOS_USER_TOKEN_TTL_HOURS`, `CHRONOS_LOGIN_MAX_FAILURES`, `CHRONOS_LOGIN_LOCKOUT_SECONDS`, `CHRONOS_SHUTDOWN_TIMEOUT_MS` or `CHRONOS_READINESS_TIMEOUT_MS`, although `.env.example` documented them. Setting them had no effect in Docker. | Forwarded (plus the new variables), and verified inside the running container. |
| 4 | Medium | API responses containing bearer tokens (login, credential create and rotate, bootstrap) carried no cache directives. | `Cache-Control: no-store` and `X-Content-Type-Options: nosniff` on `/v1/*` and `/health/*`. |
| 5 | Low | CORS did not expose `Retry-After`, so a browser dashboard could not read lockout and backoff hints. | Exposed. |
| 6 | Low | Execution detail silently capped logs at 500 lines. | `logsTruncated` flag and a paginated `/logs` endpoint. |
| 7 | Medium | Manual triggers stamped `next_attempt_at` and `scheduled_for` with the **application** clock, while the dispatcher selects `next_attempt_at <= now()` on the **database** clock. When the server's clock runs ahead of PostgreSQL's, a manual run is delayed by the full skew. Found when an existing outbox test failed once during this audit; it had passed before. | Uses the database clock (`SELECT now()` in the transaction). A regression test fakes an application clock 1 h ahead. It fails on the old code and passes now. |

Missing functionality added for the dashboard:
- `GET /v1/system`
- `PATCH /v1/auth/me` and `POST /v1/auth/password`
- `GET /v1/organizations/:orgId/audit-logs`
- `POST …/schedule/preview` and `GET …/schedule/upcoming`
- `GET …/executions/:id/logs`
- execution filters `trigger`, `mode`, `from`, `to`
- `stats?jobId` with p50/p95 durations, and `GET …/stats/timeseries`
- job filters `q` and `source`
- `GET` and `DELETE …/agents/:agentId`
- the event stream `GET …/events`

It also needed one migration, which adds two indexes.

## 5. Security review

| Topic | Finding |
| --- | --- |
| Authentication bypass | None found. A global guard fails closed, and routes opt in to other principal kinds explicitly. One uniform `401` for every invalid-token condition. Tokens over 128 chars are rejected before the lookup. |
| Authorization gaps | Every project route resolves the organization through the project and checks membership. Queries are additionally filtered by `projectId` (execution, job and agent ids from another project return `404`). The new endpoints follow the same pattern and have tests for foreign-project access. |
| Project data leakage | None found. Workers are installation-wide by design and visible to every signed-in user (hostnames, versions). |
| WebSockets | Agent auth happens at upgrade (no socket for bad tokens), with frame size and schema limits. Cross-site WebSocket hijacking does not apply (bearer header, no cookies). Fixed: re-validation (#1). |
| Secrets | Tokens are stored as SHA-256 only. Passwords use scrypt. Webhook secrets are **plaintext in PostgreSQL** (masked in the API): **open, Medium**, see §9. |
| Input validation | Strict Zod on every body and query; unknown fields rejected; 1 MB body limit. |
| SQL injection | All SQL uses Prisma or tagged-template parameters. `$queryRawUnsafe` appears only in test setup with constant strings. |
| SSRF | Checked inside DNS resolution (rebinding-safe); loopback and metadata always blocked; redirects not followed (verified in e2e: `169.254.169.254` → `BLOCKED_DESTINATION`). |
| Rate limiting | **Resolved after the audit.** Per-minute limits are kept in Redis and shared by all replicas: per bearer token, per client address without a token, and a per-address lockout after repeated *unknown* tokens (expired or revoked sessions do not count). Requests over a limit get `429` with `Retry-After`. The per-email login lockout remains, and anyone who knows an email address can still trigger it (lockout DoS; Low). |
| Logs | The `Authorization` and cookie headers are redacted; tokens and passwords are never logged; readiness errors hide driver messages. |
| Credential display | Tokens are returned only on create, rotate and bootstrap. Lists show `displayPrefix` only. |

## 6. Database and data integrity

* All required models exist: tenancy, credentials, jobs, schedules, executions, attempts, logs, agents,
  workers, audit, system state. Migrations reproduce `schema.prisma` exactly (drift check:
  "No difference detected").
* Uniqueness: `(project_id, name)` jobs, `(job_id, idempotency_key)` executions (scheduled
  occurrences and manual keys), `(execution_id, attempt_number)`, token hash, slugs.
* Indexes cover the scheduler hot path, outbox and lease sweeps, keyset listings, and the new change
  feed `(project_id, updated_at)` and project activity `(project_id, created_at)`.
* Concurrency: claims use `FOR UPDATE SKIP LOCKED`; every executor write is fenced on
  (execution, attempt, lease owner), so a late or duplicate result cannot overwrite a newer
  attempt; the bootstrap and last-owner checks use row locks. All of this is covered by tests.
* Cascades: deleting an organization deletes its projects, jobs, executions and credentials
  (audit rows are kept with `organization_id = NULL`). Deleting a job deletes its history, and
  the API documents this. Projects are archived, not deleted.
* Durability: execution history lives in PostgreSQL. Redis loss loses only queued deliveries,
  which the stale sweeper re-enqueues from PostgreSQL.
* No retention for `audit_logs` (it grows without bound), or for OFFLINE `workers` rows: see §9.

## 7. API and real-time surface

**HTTP:** 52 route handlers: 2 health probes and 50 under `/v1`, including the SSE stream. 12 of them are new in this audit. The complete list is in [API_REFERENCE.md](API_REFERENCE.md).

**Agent protocol (WebSocket):**
- client → server: `hello`, `ack`, `heartbeat`, `log`, `result`, `goodbye`
- server → client: `welcome`, `execute`, `cancel`, `result_ack`, `error`
- close codes 1000/1001/4000–4005

**Dashboard stream (SSE):** `ready`, `execution.updated`, `agent.updated`, `worker.updated`,
`close`, and keepalives. See [WEBSOCKET_PROTOCOL.md](WEBSOCKET_PROTOCOL.md).

## 8. Dashboard readiness checklist

| Page | Requirements | Status |
| --- | --- | --- |
| 1. Overview | stats, timeseries, recent failures, live events, health | IMPLEMENTED AND VERIFIED |
| 2. Jobs management | list/search/filter, create, edit, enable, pause, trigger, delete | IMPLEMENTED AND VERIFIED. The list is unpaginated (fine for hundreds of jobs) |
| 3. Job details | job, saved-schedule preview, history by job, per-job stats | IMPLEMENTED AND VERIFIED |
| 4. Schedule calendar | upcoming projection + past executions by range | IMPLEMENTED AND VERIFIED. Projection ignores misfire skips |
| 5. Execution history | filters, keyset pages, cancel and retry, live | IMPLEMENTED AND VERIFIED. No bulk actions or alternative sort orders |
| 6. Execution details and logs | attempts timeline, logs, log tail, cancel and retry | IMPLEMENTED AND VERIFIED. Log tail is by polling, not push |
| 7. Agent management | list, detail, remove offline, disconnect via revoke, live | IMPLEMENTED AND VERIFIED |
| 8. Worker management | list, live status | IMPLEMENTED AND VERIFIED. No removal of stale worker rows |
| 9. Activity logs | filtered, paginated, actor names | IMPLEMENTED AND VERIFIED |
| 10. Organization settings | get, rename, delete, switch | IMPLEMENTED AND VERIFIED |
| 11. Project settings | create, rename, time zone, archive | IMPLEMENTED AND VERIFIED |
| 12. Credentials | list, create, rotate, revoke | IMPLEMENTED AND VERIFIED |
| 13. Users and roles | members, roles, own profile and password | IMPLEMENTED AND VERIFIED. No admin password reset (by design) |

Pages that need nothing more from the backend: all 13. Notifications and alerting (email,
Slack on failure) were never part of the approved scope and are NOT APPLICABLE.

## 9. Remaining limitations and risks

None of these blocks dashboard development.

| Item | Impact | Recommendation |
| --- | --- | --- |
| No lint configuration | Style and unused-code issues are not caught automatically | Add ESLint (typescript-eslint) in a separate change |
| Webhook secrets not encrypted at rest | DB or backup compromise exposes webhook credentials | Envelope encryption with a key from env or KMS |
| `audit_logs` never pruned; offline worker rows never removed | Slow table growth | Retention setting / worker cleanup |
| Jobs list unpaginated | Large projects (thousands of jobs) | Add a cursor when needed |
| Event stream is a polled change feed (≤1 s latency, no replay) | Clients must refetch after reconnect | Documented; acceptable for a dashboard |
| Login lockout is per email | Anyone can lock out a known email for 15 min | Add a per-IP dimension |
| Some timestamps still come from the process clock: attempt `finishedAt`, executor heartbeats, `created_at` (Prisma fills `@default(now())` itself) | Display offsets under clock skew; offline detection tolerates tens of seconds | Keep NTP on all hosts. Scheduling and dispatch decisions all use the database clock |
| Option B / external network / TLS proxy / multi-replica SSE not run | Untested deployment paths | Run once in staging |

## 10. Completion estimate

About **95%** of the approved backend scope is implemented and verified at runtime. The
remaining 5% is the unverified deployment variants, the lint setup and the minor gaps above.
For dashboard development specifically, every required contract exists and is tested.

## 11. Addendum: queue jobs (immediate and delayed)

Implemented after the audit (design: [QUEUE_JOBS_DESIGN.md](QUEUE_JOBS_DESIGN.md), contract:
[QUEUE_JOBS.md](QUEUE_JOBS.md)). Migration `20261127000000_queue_jobs` was tested on a populated
database: it backfills a `default` queue per project and per-execution retry settings, and
project deletion still cascades.

| Check | Result |
| --- | --- |
| Type check / build | Pass (16/16, 10/10) |
| Unit tests | 82/82 (engine 19, including priority mapping and payload schemas) |
| Integration tests | **108/108** (22 new: REST, SDK and batch submission; idempotency under 8 concurrent requests; delay not early; cancel before due; Redis flush with delayed jobs; queue limit with 4 concurrent dispatchers; job `maxConcurrency`; no starvation with 450 rows in a saturated queue; pause/resume; priority order and BullMQ priority; retry overrides to dead letter; HTTP, worker and agent modes; payload schemas; queue CRUD and roles; agent-token limits; BullMQ removal on cancel; dispatcher wake-up with a 60 s tick) |
| Docker e2e | SDK `queue()` from a separate process: worker, HTTP and agent jobs SUCCEEDED, starting 0.07–0.48 s after submission. A 4 s delayed job started at +4.3 s. Idempotent repeat returned the same id. A cancelled delayed job never ran (0 attempts). An unknown job raised `ChronosNotFoundError`. A paused queue held work (`waiting: 1`) until resumed. Batch 2 created / 1 failed. 0 error log lines |
