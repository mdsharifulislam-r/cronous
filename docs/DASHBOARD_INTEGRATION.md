# Dashboard integration guide

This is for engineers building the Chronos web dashboard (Next.js). The reference
implementation is `apps/dashboard` (see its README); it follows pattern A below. Every endpoint
referenced here exists and is covered by integration tests. Full parameter lists are in
[API_REFERENCE.md](API_REFERENCE.md), and the event stream is specified in
[WEBSOCKET_PROTOCOL.md](WEBSOCKET_PROTOCOL.md#dashboard-real-time-protocol).

## 1. Base URL and environments

| Setting | Example | Notes |
| --- | --- | --- |
| API base URL | `https://chronos.example.com/v1` | Health probes are at `/health/live` and `/health/ready` (no `/v1`) |
| Local development | `http://127.0.0.1:8080/v1` | Docker Compose publishes on `127.0.0.1:8080` |

Environment variables for the Next.js app (choose a pattern in §3):

```bash
# Server-side only (route handlers / server actions): never exposed to the browser
CHRONOS_API_URL=http://chronos-server-1:8080      # internal URL, e.g. on a shared Docker network
# Only if the browser calls Chronos directly (pattern B)
NEXT_PUBLIC_CHRONOS_API_URL=https://chronos.example.com
```

## 2. Authentication flow

1. **First run.** If `GET /v1/bootstrap/status` returns `{bootstrapped:false}`, show a setup screen
   that asks for the bootstrap token from the server log, the admin account, the organization and the first
   project, and posts them to `POST /v1/bootstrap`. Show the returned `projectKey` and
   `agentToken` once, with a copy button and a warning. They cannot be retrieved again.
2. **Sign in.** `POST /v1/auth/login {email, password}` returns `{token, expiresAt, user}`.
3. **Session.** Send `Authorization: Bearer <token>` on every call. `GET /v1/auth/me` returns
   the user and their organizations with roles, which drives the org switcher and role-based UI.
4. **Expiry.** Tokens live `CHRONOS_USER_TOKEN_TTL_HOURS` (default 12 h). There is no
   refresh endpoint. On any `401`, clear the session and redirect to sign-in. Use
   `expiresAt` to warn before expiry.
5. **Sign out.** `POST /v1/auth/logout` revokes the token on the server.
6. **Lockout.** `429` from login or the password change carries `Retry-After` (seconds). Show it.

Role gating in the UI is only cosmetic, because the server enforces every rule. The role model:

| Role | Can |
| --- | --- |
| VIEWER | Read everything in the organization except credentials and the activity log |
| MEMBER | + create, edit, delete, pause, trigger jobs; cancel and retry executions |
| ADMIN | + projects, credentials, members (below OWNER), activity log, remove agents |
| OWNER | + delete the organization, manage owners |

## 3. Token handling (security)

**Recommended, pattern A: backend-for-frontend.** Next.js route handlers or server actions
call Chronos with the token, and the browser only holds an `httpOnly; Secure; SameSite=Lax` session
cookie that maps to the token on the server. This has three benefits:

* the token is never readable by page JavaScript (an XSS bug cannot steal it)
* Chronos needs **no CORS** configuration
* the event stream can be proxied (see §8)

**Pattern B: browser calls Chronos directly.** Keep the token in memory (React state). Use
`sessionStorage` at most, never `localStorage`. Set `CHRONOS_CORS_ORIGINS` to the dashboard's origin.

## 4. CORS

Needed only for pattern B. The relevant server settings:

```bash
CHRONOS_CORS_ORIGINS=https://dashboard.example.com,http://localhost:3000
```

* Origins must match exactly (scheme, host, port). `*` is not supported.
* `credentials` is `false`: Chronos uses bearer tokens, not cookies.
* Exposed response headers: `X-Request-Id` and `Retry-After`.
* With an empty list (the default), no CORS headers are sent, and browsers block cross-origin calls.

## 5. Response, error and pagination formats

```ts
type ApiSuccess<T> = { data: T; meta: { requestId: string; apiVersion: '1' } };
type ApiFailure = {
  error: { code: 'BAD_REQUEST' | 'VALIDATION_FAILED' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT'
               | 'PAYLOAD_TOO_LARGE' | 'TOO_MANY_REQUESTS' | 'SERVICE_UNAVAILABLE' | 'ALREADY_BOOTSTRAPPED' | 'INTERNAL_ERROR';
           message: string; details?: unknown };
  meta: { requestId: string; apiVersion: '1' };
};
```

* `VALIDATION_FAILED.details` is `[{ path: 'schedule.cron', message: '…' }]`. Map `path` to
  form fields.
* Show `meta.requestId` in error toasts. Operators can grep server logs for it.
* `404` also means "you have no access". Do not show "forbidden" for it.

Pagination:

| Endpoint | Style | Request | Response |
| --- | --- | --- | --- |
| Executions | keyset | `limit` (≤100), `cursor` | `{ items, nextCursor }`, newest first |
| Activity log | keyset | `limit` (≤200), `cursor` | `{ items, nextCursor }`, newest first |
| Execution logs | tail | `afterId`, `limit` (≤1000) | `{ items, nextAfterId }`, oldest first |
| Jobs, members, projects, credentials | none | – | array |
| Agents, workers | none (capped at 500) | – | array |

For infinite scroll, pass `nextCursor` back until it is `null`. Cursors are opaque. Do not build
them yourself.

## 6. Pages and the endpoints they use

Statuses: ✅ implemented and covered by integration tests, ⚠️ implemented with a limitation
noted.

### 6.1 Overview

| Need | Endpoint |
| --- | --- |
| KPI tiles: jobs, enabled, paused, agents online, executions by status, p50/p95 duration | ✅ `GET /projects/:id/stats?hours=24` |
| Success/failure chart | ✅ `GET /projects/:id/stats/timeseries?hours=24&bucket=hour` |
| Recent failures | ✅ `GET /projects/:id/executions?status=FAILED,DEAD_LETTERED&limit=10` |
| Live updates | ✅ SSE `execution.updated`, `agent.updated` |
| Health banner | ✅ `GET /health/ready` (public) |

### 6.2 Jobs list

| Need | Endpoint |
| --- | --- |
| List, search, filter | ⚠️ `GET /projects/:id/jobs?q=&mode=&enabled=&source=`. Unpaginated; fine for hundreds of jobs, so paginate client-side |
| Pause / resume / trigger / enable toggle / delete | ✅ `POST …/pause`, `…/resume`, `…/trigger`, `PATCH {enabled}`, `DELETE` |
| SDK-managed badge | ✅ `job.source === 'SDK'`. Only `enabled` can be edited; disable other fields |

### 6.3 Job details and editor

| Need | Endpoint |
| --- | --- |
| Definition | ✅ `GET /projects/:id/jobs/:jobId` |
| Next runs of the saved schedule | ✅ `GET …/jobs/:jobId/schedule/preview?count=10` |
| Live cron validation while typing | ✅ `POST /projects/:id/schedule/preview` (nothing is saved; `400 VALIDATION_FAILED` for bad cron or zone) |
| Create / update | ✅ `POST /projects/:id/jobs`, `PATCH …/jobs/:jobId` |
| Execution history of the job | ✅ `GET /projects/:id/executions?jobId=` |
| Job statistics | ✅ `GET /projects/:id/stats?jobId=`, `…/stats/timeseries?jobId=` |

**Editing webhook secrets.** Responses mask secrets as `"********"`. Send the `http`
object back as received, changing only what the user edited. Masked values keep the stored
secret. To change a secret, send the new value. Omit `http` entirely to leave it untouched.

### 6.4 Schedule calendar

| Need | Endpoint |
| --- | --- |
| Future occurrences | ⚠️ `GET /projects/:id/schedule/upcoming?from=&to=` (≤93 days; capped, see `truncated`). A projection: it does not model misfire skips |
| Past runs | ✅ `GET /projects/:id/executions?from=&to=` (by creation time) |

### 6.5 Execution history

| Need | Endpoint |
| --- | --- |
| List with filters | ✅ `GET /projects/:id/executions?status=&jobId=&trigger=&mode=&from=&to=&cursor=` |
| Bulk actions | ⚠️ No bulk endpoint; call cancel or retry per execution |
| Sorting | ⚠️ Newest first only |
| Live | ✅ SSE `execution.updated` (upsert into the list if it matches the filters) |

### 6.6 Execution details and logs

| Need | Endpoint |
| --- | --- |
| Attempts timeline (executor, error code, HTTP status, output) | ✅ `GET /projects/:id/executions/:executionId` |
| Logs | ✅ First 500 in the detail response (`logsTruncated`); then `GET …/logs?afterId=` |
| Live log tail | ✅ Poll `…/logs?afterId=<nextAfterId>` every 1–2 s while the status is `RUNNING`; logs are not pushed over SSE |
| Cancel / retry | ✅ `POST …/cancel`, `POST …/retry` |

### 6.7 Agents

| Need | Endpoint |
| --- | --- |
| List, detail | ✅ `GET /projects/:id/agents?status=`, `GET …/agents/:agentId` |
| Remove stale agent | ✅ `DELETE …/agents/:agentId` (OFFLINE only) |
| Disconnect an agent | ✅ Revoke its credential; it disconnects within `CHRONOS_CREDENTIAL_RECHECK_MS` |
| Live | ✅ SSE `agent.updated` |

### 6.8 Workers

| Need | Endpoint |
| --- | --- |
| List | ✅ `GET /v1/workers` (installation-wide) |
| Live | ✅ SSE `worker.updated` (user sessions) |
| Remove stale worker | ⚠️ Not available; offline worker rows stay until removed in the database |

### 6.9 Activity log

✅ `GET /organizations/:orgId/audit-logs?projectId=&action=job.&from=&to=&cursor=` (ADMIN).
Actor names are resolved in the response.

### 6.10 Organization settings

✅ `GET/PATCH/DELETE /organizations/:orgId`, `GET /organizations` (switcher), `POST /organizations`.

### 6.11 Project settings

✅ `GET /organizations/:orgId/projects`, `POST …/projects`, `GET/PATCH/DELETE /projects/:id`
(DELETE archives the project and revokes its credentials).

### 6.12 API and agent credentials

✅ `GET/POST /projects/:id/credentials`, `POST …/:credentialId/rotate`, `DELETE …/:credentialId` (ADMIN).
The token appears only in the create and rotate responses.

### 6.13 Users and roles

| Need | Endpoint |
| --- | --- |
| Members list | ✅ `GET /organizations/:orgId/members` |
| Invite (existing user) / create user with initial password | ✅ `POST …/members` (no email delivery exists; share the password out of band) |
| Change role / remove | ✅ `PATCH`, `DELETE …/members/:userId` |
| Own profile / password | ✅ `PATCH /auth/me`, `POST /auth/password` |
| Admin password reset, user deactivation | ⚠️ Not available by design: users are installation-wide, and org admins cannot change accounts |

### 6.14 Queues (immediate and delayed jobs)

| Need | Endpoint |
| --- | --- |
| Queue list with live counts (waiting, delayed, retrying, queued, running) | ✅ `GET /projects/:id/queues` |
| Create / edit limit and default priority / delete | ✅ `POST`, `PATCH`, `DELETE …/queues/:name` (ADMIN) |
| Pause / resume | ✅ `POST …/queues/:name/pause`, `…/resume` |
| Submit a job now or later ("Run with payload…" dialog) | ✅ `POST /projects/:id/queue` (`delayMs` / `runAt`, `priority`, `idempotencyKey`) |
| Delayed and queued executions | ✅ `GET …/executions?trigger=QUEUE&delayed=true&queue=` |
| Live | ✅ SSE `execution.updated` (now with `queue`, `priority`, `delayed`) |

Show queue and priority columns in execution lists, and a "delayed until" time (`nextAttemptAt`)
when `delayed` is true. See [QUEUE_JOBS.md](QUEUE_JOBS.md).

### 6.15 Settings / about

✅ `GET /v1/system`: version, feature flags, server time, retention and token TTL.

## 7. Example API client (TypeScript)

```ts
// lib/chronos.ts — works server-side (pattern A) or in the browser (pattern B)
export class ChronosError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown, public requestId?: string) {
    super(message);
  }
}

export function chronosClient(baseUrl: string, getToken: () => string | undefined) {
  async function request<T>(method: string, path: string, body?: unknown, query?: Record<string, string | number | undefined>): Promise<T> {
    const url = new URL(`${baseUrl}/v1${path}`);
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    const token = getToken();
    const response = await fetch(url, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    if (response.status === 204) return undefined as T;
    const json = await response.json();
    if (!response.ok) throw new ChronosError(response.status, json.error?.code, json.error?.message, json.error?.details, json.meta?.requestId);
    return json.data as T;
  }

  return {
    login: (email: string, password: string) => request<{ token: string; expiresAt: string; user: { id: string; email: string; name: string } }>('POST', '/auth/login', { email, password }),
    me: () => request<{ id: string; organizations: { id: string; name: string; slug: string; role: string }[] }>('GET', '/auth/me'),
    jobs: (projectId: string, filter: { q?: string; mode?: string } = {}) => request<unknown[]>('GET', `/projects/${projectId}/jobs`, undefined, filter),
    trigger: (projectId: string, jobId: string, payload?: unknown, idempotencyKey?: string) =>
      request<{ execution: { id: string }; created: boolean }>('POST', `/projects/${projectId}/jobs/${jobId}/trigger`, { payload, idempotencyKey }),
    executions: (projectId: string, query: { status?: string; jobId?: string; cursor?: string; limit?: number } = {}) =>
      request<{ items: unknown[]; nextCursor: string | null }>('GET', `/projects/${projectId}/executions`, undefined, query),
    previewSchedule: (projectId: string, schedule: { cron?: string; runAt?: string; timezone?: string }, count = 5) =>
      request<{ occurrences: string[]; timezone: string }>('POST', `/projects/${projectId}/schedule/preview`, { schedule, count }),
  };
}
```

Use the user's action as the idempotency key for manual triggers (for example, a UUID created when
the dialog opens). A double click then creates one execution: the second call returns
`200` with `created:false`.

## 8. Real-time events in the browser

`EventSource` cannot send `Authorization`, so read the stream with `fetch`:

```ts
// lib/events.ts
export function subscribeProjectEvents(
  url: string, token: string,
  onEvent: (type: string, data: any) => void,
  onReconnect: () => void, // refetch lists here: events are not replayed
): () => void {
  let stopped = false;
  let controller: AbortController;

  async function run(attempt = 0): Promise<void> {
    controller = new AbortController();
    try {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
      if (response.status === 401 || response.status === 404) return onEvent('close', { reason: 'unauthorized' });
      if (!response.ok || !response.body) throw new Error(`stream failed: ${response.status}`);
      if (attempt > 0) onReconnect();
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const type = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (type && data) {
            const parsed = JSON.parse(data);
            if (type === 'close') { stopped = stopped || parsed.reason === 'unauthorized'; }
            onEvent(type, parsed);
          }
        }
      }
    } catch {
      /* network error or abort */
    }
    if (!stopped) setTimeout(() => void run(attempt + 1), Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)));
  }

  void run();
  return () => { stopped = true; controller?.abort(); };
}
```

```ts
// usage (React Query style)
useEffect(() => subscribeProjectEvents(`${api}/v1/projects/${projectId}/events`, token,
  (type, data) => {
    if (type === 'execution.updated') queryClient.setQueryData(['execution', data.id], (old: any) => ({ ...old, ...data }));
    if (type === 'execution.updated' || type === 'agent.updated') queryClient.invalidateQueries({ queryKey: ['stats', projectId] });
    if (type === 'close' && data.reason === 'unauthorized') signOut();
  },
  () => queryClient.invalidateQueries({ queryKey: ['project', projectId] }),
), [projectId, token]);
```

With pattern A, expose a Next.js route handler that opens the upstream stream server-side
with the token from the session, and returns `new Response(upstream.body, { headers: {
'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } })`. Run it on the Node.js
runtime with `export const dynamic = 'force-dynamic'`.

## 9. Request and response examples

```http
POST /v1/projects/7d0c…/jobs
Authorization: Bearer chr_u_…
Content-Type: application/json

{"name":"nightly-sync","mode":"HTTP","http":{"url":"https://app.example.com/jobs/sync","signingSecret":"0123456789abcdef"},
 "schedule":{"cron":"30 1 * * *","timezone":"Asia/Dhaka"},"maxAttempts":5}
```

```json
201 Created
{ "data": { "id": "…", "name": "nightly-sync", "mode": "HTTP", "source": "API", "enabled": true,
            "http": { "url": "https://app.example.com/jobs/sync", "method": "POST", "headers": {}, "signingSecret": "********" },
            "schedule": { "type": "CRON", "cron": "30 1 * * *", "timezone": "Asia/Dhaka", "state": "ACTIVE",
                          "nextRunAt": "2026-11-26T19:30:00.000Z", "misfirePolicy": "FIRE_ONCE", "version": 1, "…": "…" },
            "maxAttempts": 5, "timeoutMs": 300000, "…": "…" },
  "meta": { "requestId": "4a0e…", "apiVersion": "1" } }
```

```http
GET /v1/projects/7d0c…/executions?status=FAILED,DEAD_LETTERED&limit=2
```

```json
{ "data": { "items": [ { "id": "…", "jobName": "nightly-sync", "status": "DEAD_LETTERED", "attemptCount": 5,
                         "lastError": "HTTP 503", "trigger": "SCHEDULE", "scheduledFor": "…", "finishedAt": "…" } ],
            "nextCursor": "MjAyNi0xMS0yNlQwOTowMDowMC4wMDBafGFi…" },
  "meta": { "requestId": "…", "apiVersion": "1" } }
```

```json
400 Bad Request
{ "error": { "code": "VALIDATION_FAILED", "message": "Request validation failed",
             "details": [ { "path": "schedule.cron", "message": "invalid cron expression: …" } ] },
  "meta": { "requestId": "…", "apiVersion": "1" } }
```

## 10. Things the dashboard should not assume

* **At-least-once execution.** The same `idempotencyKey` can show several attempts, and in rare
  cases a handler runs twice. Do not present Chronos as "exactly once".
* **Times.** All timestamps are UTC. Render them in the job's or project's `timezone`, and show
  the zone next to cron expressions.
* **Deleting a job deletes its history.** Say so in the confirmation dialog. Disabling the job
  keeps history.
* **Archiving a project is not reversible through the API.**
* **The bundled vanilla-JS UI** at `/dashboard` (`apps/dashboard-lite`) stays available. Set
  `CHRONOS_DASHBOARD_ENABLED=false` once the Next.js dashboard replaces it.
