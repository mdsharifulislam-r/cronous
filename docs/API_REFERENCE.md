# Chronos REST API reference (v1)

The source of truth is the code: controllers in `apps/server/src/modules/*/*.controller.ts`
and the Zod schemas next to them. This document lists every route that exists today.
Real-time events are in [WEBSOCKET_PROTOCOL.md](WEBSOCKET_PROTOCOL.md).

## Conventions

**Base URL.** `https://<chronos-host>/v1`. Health probes live outside the prefix at
`/health/*`.

**Authentication.** Send `Authorization: Bearer <token>`. Token kinds are recognisable by prefix:

| Prefix | Kind | Obtained from | Accepted by |
| --- | --- | --- | --- |
| `chr_b_` | Bootstrap token | Server log on first start, or `CHRONOS_BOOTSTRAP_TOKEN` | `POST /v1/bootstrap` only; invalid after first use |
| `chr_u_` | User session | `POST /v1/auth/login` (expires after `CHRONOS_USER_TOKEN_TTL_HOURS`) | All user routes |
| `chr_p_` | Project API key | Credentials API | Routes marked **key** below, inside its own project only |
| `chr_a_` | Agent token | Credentials API | The agent WebSocket (`/v1/agent/ws`), job submission (`POST …/queue`, `…/queue/batch`), cancelling not-yet-started executions, `GET /v1/agent/identity` and `GET /v1/identity` |

Unknown, expired, revoked and malformed tokens all return the same `401 UNAUTHORIZED`.
Token kinds that a route does not accept return `403 FORBIDDEN`.

**Authorization.** Organization roles are ranked `VIEWER < MEMBER < ADMIN < OWNER`. Each route
states the minimum role. The organization comes from `:orgId`, or from `:projectId` through
the project. Callers who are not members get `404 NOT_FOUND`, not `403`, so ids cannot be
probed. Project API keys act with at most `MEMBER` rights and only inside their own project.
Archived projects return `404`.

**Envelopes.** Every JSON response is wrapped in an envelope:

```json
{ "data": { "...": "..." }, "meta": { "requestId": "6f1c…", "apiVersion": "1" } }
```

```json
{ "error": { "code": "VALIDATION_FAILED", "message": "Request validation failed",
             "details": [ { "path": "schedule.cron", "message": "invalid cron expression" } ] },
  "meta": { "requestId": "6f1c…", "apiVersion": "1" } }
```

`204 No Content` responses have no body. Every response carries `X-Request-Id`. A
log-safe `X-Request-Id` sent by the client is reused. API responses also carry
`Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

**Error codes.**

| HTTP | `error.code` | When |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | Semantically invalid request, malformed JSON |
| 400 | `VALIDATION_FAILED` | Schema validation; `details` lists `{path, message}` |
| 401 | `UNAUTHORIZED` | Missing or invalid credential |
| 403 | `FORBIDDEN` | Valid credential, insufficient role or wrong credential kind |
| 404 | `NOT_FOUND` | Missing resource, or no access to it |
| 409 | `CONFLICT` | Uniqueness, state conflicts (e.g. cancelling a finished execution) |
| 409 | `ALREADY_BOOTSTRAPPED` | Bootstrap after success |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 1 MB |
| 429 | `TOO_MANY_REQUESTS` | Rate limit exceeded (per token, per address, or too many unknown tokens from one address), or login/password lockout; `Retry-After` header set |
| 503 | `SERVICE_UNAVAILABLE` | Database busy, dependencies down, stream limit; `Retry-After` when known |
| 500 | `INTERNAL_ERROR` | Bug; details are logged server-side with the request id |

**Rate limits.** Requests under `/v1` are counted per minute: per bearer token (default 1200),
per client address without a token (120), and an address that presents 30 unknown tokens is
refused until the window ends. Responses carry `X-RateLimit-Limit`, `X-RateLimit-Remaining`
and `X-RateLimit-Reset` (seconds). A batch submission counts as one request. Health probes
are not limited.

**Validation.** Request bodies and query strings are validated strictly. Unknown fields are
rejected with `VALIDATION_FAILED`, and ids must be UUIDs.

**Pagination.** There are three styles. Each endpoint states which one it uses.

* **Keyset cursor** (executions, audit logs): pass `limit` and `cursor`, and read
  `data.nextCursor` (`null` on the last page). Results are newest first and stable under
  concurrent inserts.
* **Tail cursor** (execution logs): pass `afterId` and `limit`, and read `data.nextAfterId`. It is
  meant for polling new lines.
* **Unpaginated** (jobs, members, projects, credentials; agents and workers are capped at 500):
  the whole list is returned in `data`.

Timestamps are ISO 8601 UTC strings. Ids are UUIDs, except audit-log and execution-log ids,
which are decimal strings (64-bit).

---

## Health (public)

| Method | Path | Response |
| --- | --- | --- |
| GET | `/health/live` | `200 {status:"alive", uptimeSeconds}`. No dependency checks |
| GET | `/health/ready` | `200 {status:"ready", checks:{postgres:{status,latencyMs}, redis:{…}}}`; `503 SERVICE_UNAVAILABLE` with the same report in `details` when a dependency is down |

## System

| Method | Path | Auth | Response |
| --- | --- | --- | --- |
| GET | `/v1/system` | user | `{version, apiVersion, agentProtocolVersion, serverTime, features:{embeddedScheduler, embeddedWorker, bundledDashboard, eventStream}, limits:{userTokenTtlHours, executionRetentionDays, agentHeartbeatMs, leaseMs, eventsPollMs}}` |

Use `serverTime` to correct client clock skew in countdowns.

## Bootstrap (public, one-time)

| Method | Path | Auth | Body / response |
| --- | --- | --- | --- |
| GET | `/v1/bootstrap/status` | none | `{bootstrapped: boolean}` |
| POST | `/v1/bootstrap` | `Bearer chr_b_…` | Body `{admin:{email,name,password(12+)}, organization:{name,slug}, project:{name,slug,timezone?}}` → `201 {user, organization, project, credentials:{userToken:{token,expiresAt}, projectKey:{id,token}, agentToken:{id,token}}}`. `401` bad token, `409 ALREADY_BOOTSTRAPPED` |

Tokens in the bootstrap response are shown once.

## Authentication and account

| Method | Path | Auth | Body | Response |
| --- | --- | --- | --- | --- |
| POST | `/v1/auth/login` | none | `{email, password}` | `200 {token, expiresAt, user:{id,email,name}}`. `401` for any bad combination, `429` after `CHRONOS_LOGIN_MAX_FAILURES` failures (per email, `Retry-After`) |
| POST | `/v1/auth/logout` | user | – | `204`; revokes the presented session token |
| GET | `/v1/auth/me` | user | – | `{id, email, name, createdAt, lastLoginAt, organizations:[{id,name,slug,role}]}` |
| PATCH | `/v1/auth/me` | user | `{name}` | Same shape as GET |
| POST | `/v1/auth/password` | user | `{currentPassword, newPassword(12+, different)}` | `200 {revokedSessions}`. Revokes all *other* sessions of the user. `400` wrong current password (counts toward the login lockout), `429` while locked |

There is no refresh token. When a session expires (`401`), the user signs in again.

## Organizations

| Method | Path | Min role | Body | Response |
| --- | --- | --- | --- | --- |
| POST | `/v1/organizations` | any user | `{name, slug}` | `201 {id,name,slug,createdAt,updatedAt,role:"OWNER"}`; `409` slug taken |
| GET | `/v1/organizations` | any user | – | `[{id,name,slug,createdAt,updatedAt,role}]` (caller's organizations) |
| GET | `/v1/organizations/:orgId` | VIEWER | – | `{id,name,slug,createdAt,updatedAt,projectCount,memberCount}` |
| PATCH | `/v1/organizations/:orgId` | ADMIN | `{name}` | Organization |
| DELETE | `/v1/organizations/:orgId` | OWNER | – | `204`. Cascades to projects, jobs, executions and credentials; audit entries are kept |

### Members

| Method | Path | Min role | Body | Response |
| --- | --- | --- | --- | --- |
| GET | `/v1/organizations/:orgId/members` | VIEWER | – | `[{id,email,name,isActive,role,joinedAt}]` |
| POST | `/v1/organizations/:orgId/members` | ADMIN | `{email, role, name?, password?}` (name+password together create a new user) | `201` member. `404` unknown email without name/password, `409` already a member or existing user with password supplied |
| PATCH | `/v1/organizations/:orgId/members/:userId` | ADMIN | `{role}` | Member. Admins cannot grant or modify OWNER; the last owner cannot be demoted (`409`) |
| DELETE | `/v1/organizations/:orgId/members/:userId` | VIEWER for self, ADMIN for others | – | `204`; the last owner cannot leave (`409`) |

### Activity log

`GET /v1/organizations/:orgId/audit-logs`: **ADMIN**, user tokens only.

| Query | Type | Meaning |
| --- | --- | --- |
| `projectId` | uuid | Only entries for this project |
| `action` | string | Exact (`job.created`) or prefix ending in `.` (`job.`) |
| `actorId`, `targetType`, `targetId` | string | Exact match |
| `from`, `to` | ISO date | Inclusive range on `createdAt` |
| `limit` | 1–200, default 50 | Page size |
| `cursor` | string | `nextCursor` of the previous page |

Response `{items:[{id, action, projectId, actor:{type:"USER"|"CREDENTIAL"|"SYSTEM", id, name, email, credentialKind, credentialPrefix}, targetType, targetId, metadata, requestId, ipAddress, createdAt}], nextCursor}`.

Recorded actions:
- `system.bootstrapped`
- `organization.created|updated|deleted`
- `membership.added|role_changed|removed`
- `project.created|updated|archived`
- `credential.created|rotated|revoked`
- `job.created|updated|deleted|paused|resumed|triggered`
- `execution.cancelled|replayed`
- `agent.removed`

Login events, profile changes and password changes are recorded without an organization (`auth.*`, `user.*`), so they do not appear in organization listings.

## Projects

| Method | Path | Min role | Auth | Body | Response |
| --- | --- | --- | --- | --- | --- |
| POST | `/v1/organizations/:orgId/projects` | ADMIN | user | `{name, slug, timezone?="UTC"}` | `201 {id,organizationId,name,slug,timezone,createdAt,updatedAt}`; `409` slug exists |
| GET | `/v1/organizations/:orgId/projects` | VIEWER | user | – | Active (non-archived) projects |
| GET | `/v1/projects/:projectId` | VIEWER | user, key | – | Project |
| PATCH | `/v1/projects/:projectId` | ADMIN | user | `{name?, timezone?}` | Project |
| DELETE | `/v1/projects/:projectId` | ADMIN | user | – | `204`. Archives (history kept) and revokes all project and agent credentials; connected agents are disconnected within `CHRONOS_CREDENTIAL_RECHECK_MS` |

### Credentials

All credential routes require **ADMIN** and user tokens only.

| Method | Path | Body / query | Response |
| --- | --- | --- | --- |
| GET | `/v1/projects/:projectId/credentials` | `?includeRevoked=true\|false` | `[{id,kind:"PROJECT"\|"AGENT",name,displayPrefix,projectId,expiresAt,lastUsedAt,revokedAt,rotatedFromId,createdAt}]` (never the token) |
| POST | `/v1/projects/:projectId/credentials` | `{kind:"PROJECT"\|"AGENT", name, expiresInDays?}` | `201` credential + `token` (shown once) |
| POST | `/v1/projects/:projectId/credentials/:credentialId/rotate` | `{gracePeriodSeconds? = 3600, max 7 days; 0 revokes now}` | `200 {credential:{…,token}, previous:{…}}`; `409` if already rotated, revoked or expired |
| DELETE | `/v1/projects/:projectId/credentials/:credentialId` | – | `200` the revoked credential (idempotent) |

## Jobs

Unless noted, user tokens and project keys are both accepted.

| Method | Path | Min role | Body / query | Response |
| --- | --- | --- | --- | --- |
| GET | `/v1/projects/:projectId/jobs` | VIEWER | `?mode=HTTP\|AGENT\|WORKER&enabled=true\|false&source=API\|SDK&queue=name&q=text` | `[Job & {lastExecution:{id,status,trigger,createdAt,finishedAt}|null}]` sorted by name (unpaginated) |
| POST | `/v1/projects/:projectId/jobs` | MEMBER | CreateJob | `201 Job`; `409` name exists |
| GET | `/v1/projects/:projectId/jobs/:jobId` | VIEWER | – | `Job` |
| PATCH | `/v1/projects/:projectId/jobs/:jobId` | MEMBER | UpdateJob | `Job`. SDK-managed jobs only accept `enabled` (`409` otherwise) |
| DELETE | `/v1/projects/:projectId/jobs/:jobId` | MEMBER | – | `204`; deletes execution history too |
| POST | `/v1/projects/:projectId/jobs/:jobId/pause` | MEMBER | – | `Job`; `400` no schedule, `409` completed one-time schedule |
| POST | `/v1/projects/:projectId/jobs/:jobId/resume` | MEMBER | – | `Job`; next run recomputed from now |
| POST | `/v1/projects/:projectId/jobs/:jobId/trigger` | MEMBER | `{payload?, idempotencyKey?}` | `201 {execution, created:true}`, or `200 {execution, created:false}` when the idempotency key matched; `409` disabled job or FORBID overlap (`details.activeExecutionId`) |
| GET | `/v1/projects/:projectId/jobs/:jobId/schedule/preview` | VIEWER | `?count=1..50 (5)` | `{timezone, occurrences:[ISO]}` for the saved schedule |

**CreateJob**:

```jsonc
{
  "name": "nightly-sync",          // starts with letter/digit; letters, digits, . _ : - ; max 128; unique per project; immutable
  "description": "optional",
  "mode": "HTTP" | "AGENT" | "WORKER",
  "enabled": true,
  "http": {                        // required for HTTP, forbidden otherwise
    "url": "https://app.example.com/hook",   // http(s), no user:pass@
    "method": "POST",              // GET|POST|PUT|PATCH|DELETE
    "headers": { "X-Api-Key": "…" },
    "auth": { "type": "bearer", "token": "…" } | { "type": "basic", "username": "…", "password": "…" },
    "signingSecret": "16+ chars"   // enables X-Chronos-Signature
  },
  "payload": { },                  // JSON delivered to the handler
  "schedule": { "cron": "30 1 * * *" } | { "runAt": "2026-12-01T00:00:00Z" },
  //   + timezone (default: project's), misfirePolicy FIRE_ONCE|SKIP|FIRE_ALL,
  //     misfireGraceMs (60000), maxCatchUp (10)
  "timeoutMs": 300000, "maxAttempts": 3, "retryBackoffMs": 10000,
  "retryBackoffMaxMs": 3600000, "concurrencyPolicy": "ALLOW" | "FORBID",
  "queue": "default",              // admission lane; must exist ("default" always does)
  "priority": null,                // 0-100 default priority of this job's executions; null = queue default
  "maxConcurrency": null,          // executions of this job admitted at once; null = no job limit
  "payloadSchema": null            // JSON Schema (draft 2020-12) every payload must satisfy
}
```

**UpdateJob** takes the same fields, all optional except that at least one is required. `name` cannot
change. `schedule: null` removes the schedule.

**Job (response)**:
- Top-level fields: `{id, projectId, name, description, mode, source:"API"|"SDK", enabled, queueId, queue, priority, maxConcurrency, payloadSchema, http, payload, timeoutMs, maxAttempts, retryBackoffMs, retryBackoffMaxMs, concurrencyPolicy, createdAt, updatedAt, schedule}`.
- `schedule` is `null` or `{type:"CRON"|"ONCE", cron, runAt, timezone, state:"ACTIVE"|"PAUSED"|"COMPLETED", misfirePolicy, misfireGraceMs, maxCatchUp, nextRunAt, lastScheduledAt, version}`.

**Masked secrets.** In responses, `http` has secret values replaced by `"********"`: the bearer
token, the basic password, the signing secret, and headers whose name contains auth, token, key, secret,
cookie, signature or password. Send a masked value back unchanged to keep the stored
secret. A masked value with no stored counterpart is rejected with `400`.

## Queues and job submission (immediate and delayed jobs)

Full contract, semantics and SDK usage: [QUEUE_JOBS.md](QUEUE_JOBS.md).

| Method | Path | Min role | Auth | Body / response |
| --- | --- | --- | --- | --- |
| POST | `/v1/projects/:projectId/queue` | MEMBER | user, key, **agent** | `{job (name), payload?, delayMs? \| runAt?, priority? 0–100, queue?, idempotencyKey?, maxAttempts?, retryBackoffMs?, retryBackoffMaxMs?, timeoutMs?}` → `201 {execution, created:true}` / `200 {…, created:false}` (key replay). `400` validation or payload schema, `404` job or queue, `409` disabled |
| POST | `/v1/projects/:projectId/queue/batch` | MEMBER | user, key, agent | `{items:[submission ×1–100]}` → `200 {results:[{index, outcome: created\|duplicate\|error, execution?, error?}], summary}` |
| GET | `/v1/projects/:projectId/queues` | VIEWER | user, key | `[{id, name, description, concurrencyLimit, defaultPriority, paused, counts:{waiting, delayed, retrying, queued, running}, jobs, …}]` |
| GET | `/v1/projects/:projectId/queues/:name` | VIEWER | user, key | Queue with counts |
| POST | `/v1/projects/:projectId/queues` | ADMIN | user | `{name, description?, concurrencyLimit?, defaultPriority?}` → `201`; `409` duplicate |
| PATCH | `/v1/projects/:projectId/queues/:name` | ADMIN | user | `{description?, concurrencyLimit? (null = unlimited), defaultPriority?}` |
| DELETE | `/v1/projects/:projectId/queues/:name` | ADMIN | user | `204`; `409` for `default`, queues with jobs, or unfinished executions |
| POST | `/v1/projects/:projectId/queues/:name/pause`, `…/resume` | MEMBER | user, key | Queue |
| GET | `/v1/agent/identity` | – | agent | `{projectId, projectSlug, timezone, credentialId}` (used by the SDK) |
| GET | `/v1/identity` | – | key, agent | `{kind:"PROJECT"\|"AGENT", projectId, projectSlug, organizationId, timezone, credentialId}`: the project a credential belongs to (used by the SDK's admin client). User sessions get `403` |

## Schedules (calendar and validation)

| Method | Path | Min role | Body / query | Response |
| --- | --- | --- | --- | --- |
| POST | `/v1/projects/:projectId/schedule/preview` | VIEWER | `{schedule: <schedule definition>, count?=10 (≤50)}` | `{type, timezone, occurrences:[ISO], inPast}`. Invalid cron or zone → `400 VALIDATION_FAILED`. Nothing is saved |
| GET | `/v1/projects/:projectId/schedule/upcoming` | VIEWER | `?to=ISO (required)&from=ISO (default now)&jobId=` | `{from, to, occurrences:[{at, jobId, jobName, mode}], truncated, truncatedJobs}` |

`upcoming` projects the current definitions of ACTIVE schedules of enabled jobs. It does not
include past runs (query executions for those), and occurrences that a misfire policy would
skip are not modelled. The range is at most 93 days, results are capped at 2,000 per job and 10,000 in total,
and `truncated` reports when a cap applied.

## Executions

| Method | Path | Min role | Query / body | Response |
| --- | --- | --- | --- | --- |
| GET | `/v1/projects/:projectId/executions` | VIEWER | `jobId, status (comma list), trigger=SCHEDULE\|MANUAL\|QUEUE, mode, queue, delayed=true\|false, agentId, workerId (ran at least one attempt), from, to (on createdAt), limit 1–100 (50), cursor` | `{items:[ExecutionSummary], nextCursor}`; newest first |
| GET | `/v1/projects/:projectId/executions/:executionId` | VIEWER | – | ExecutionDetail |
| GET | `/v1/projects/:projectId/executions/:executionId/logs` | VIEWER | `afterId, limit 1–1000 (200)` | `{items:[Log], nextAfterId}`; oldest first |
| POST | `/v1/projects/:projectId/executions/:executionId/cancel` | MEMBER (user, key, agent) | – | `{id, status:"CANCELLED", previousStatus}`; `409` already finished, or already started when called with an agent token |
| POST | `/v1/projects/:projectId/executions/:executionId/retry` | MEMBER | – | `{id, status:"PENDING"}`; only FAILED, DEAD_LETTERED or CANCELLED (`409` otherwise) |
| GET | `/v1/projects/:projectId/stats` | VIEWER | `hours 1–720 (24), jobId, queue` | `{windowHours, jobId, queue, executions:{<STATUS>:count}, byMode:{HTTP,AGENT,WORKER}, byKind:{scheduled,manual,immediate,delayed}, jobs, jobsEnabled, jobsPaused, agentsOnline, durationMs:{p50,p95}}` |
| GET | `/v1/projects/:projectId/stats/timeseries` | VIEWER | `hours 1–720 (24), bucket=hour\|day, jobId, queue, mode` | `{bucket, windowHours, points:[{at, counts:{<STATUS>:n}, byMode, byKind, durationMs:{p50,p95}}]}`; UTC buckets, oldest first, empty buckets included |

**Execution statuses:**
- `PENDING`: durable, not yet queued
- `QUEUED`
- `RUNNING`
- `RETRY_SCHEDULED`
- `SUCCEEDED`
- `FAILED`: non-retryable
- `CANCELLED`
- `DEAD_LETTERED`: attempts exhausted

The terminal statuses are `SUCCEEDED`, `FAILED`, `CANCELLED` and `DEAD_LETTERED`.

**ExecutionSummary**: `{id, jobId, jobName, queue, priority, delayed, executor:{kind:"AGENT"|"WORKER", id, name}|null, trigger, status, mode, scheduledFor, idempotencyKey, attemptCount, maxAttempts, nextAttemptAt, startedAt, finishedAt, lastError, createdAt}`. `idempotencyKey` is the key as submitted; scheduled occurrences show `sched:<ISO time>`, and submissions without a key show a generated value.

**ExecutionDetail** has the summary fields plus:
- `payload`, `timeoutMs`, `leaseOwner`, `leaseExpiresAt`, `result`, `updatedAt`
- `attempts:[{id, attemptNumber, status: RUNNING|SUCCEEDED|FAILED|TIMED_OUT|ABANDONED, agentId, workerId, agent:{id,hostname,instanceId}|null, worker:{…}|null, startedAt, finishedAt, leaseExpiresAt, errorCode, errorMessage, httpStatus, output}]`
- `logs`: the first 500 entries
- `logsTruncated`: when true, page through the rest with `/logs`

**Log**: `{id, executionId, attemptId, level: DEBUG|INFO|WARN|ERROR, message, data, createdAt}`.

Finished executions older than `CHRONOS_EXECUTION_RETENTION_DAYS` are deleted by the reaper.

## Agents and workers

| Method | Path | Min role | Auth | Response |
| --- | --- | --- | --- | --- |
| GET | `/v1/projects/:projectId/agents` | VIEWER | user, key | `?status=ONLINE\|DRAINING\|OFFLINE` → `[{id, credentialId, instanceId, hostname, sdkVersion, protocolVersion, status, handlers, connectedAt, lastHeartbeatAt, disconnectedAt}]` (≤500) |
| GET | `/v1/projects/:projectId/agents/:agentId` | VIEWER | user, key | Agent + `metadata`, `runningExecutions` |
| DELETE | `/v1/projects/:projectId/agents/:agentId` | ADMIN | user | `204`; only OFFLINE agents (`409` otherwise; revoke the credential to disconnect one) |
| GET | `/v1/workers` | any user | user | `[{id, instanceId, hostname, version, status, concurrency, runningExecutions, startedAt, lastHeartbeatAt, stoppedAt}]` (≤500, installation-wide) |
| GET | `/v1/workers/:workerId` | any user | user | Worker + `runningExecutions`, `attempts24h:{succeeded,failed,timedOut,abandoned}` (all projects), `modes`, `recentAttempts` (only projects of organizations the caller belongs to) |

## Real-time events

`GET /v1/projects/:projectId/events` (VIEWER; user or key) is a `text/event-stream`. See
[WEBSOCKET_PROTOCOL.md](WEBSOCKET_PROTOCOL.md#dashboard-real-time-protocol).

## Agent protocol

`GET /v1/agent/ws` (WebSocket upgrade, `chr_a_` token). See
[WEBSOCKET_PROTOCOL.md](WEBSOCKET_PROTOCOL.md#agent-protocol).
