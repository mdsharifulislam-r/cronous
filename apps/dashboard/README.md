# Chronos Dashboard

Next.js 16 (App Router) dashboard for Chronos: jobs, queues, schedules, executions, agents,
workers, activity and settings, on top of the Chronos REST API and its dashboard event stream.

The small static UI that the API server itself serves at `/dashboard` lives in
`apps/dashboard-lite`. This app is the full dashboard and runs as its own process.

## Architecture

```
Browser ──(httpOnly session cookie)──▶ Next.js (this app) ──(Bearer chr_u_…)──▶ Chronos API
                                        ├─ /api/session            sign in / out / me
                                        ├─ /api/session/bootstrap  first-time setup
                                        └─ /api/chronos/*          allowlisted proxy to /v1/* and /health/*
```

* **Backend-for-frontend session.** The Chronos API uses bearer tokens (12 h, no refresh
  endpoint). The dashboard server stores the token in an `httpOnly`, `SameSite=Lax` cookie
  (`Secure` in production). Browser JavaScript never sees a token, and Chronos needs no CORS.
* **CSRF.** Mutations through the dashboard must carry `x-chronos-csrf: 1` and a same-origin
  `Origin`. The proxy refuses anything else with `403`.
* **Proxy allowlist.** `/api/chronos/*` forwards only `v1/**` and `health/(live|ready)`. Login,
  bootstrap and the agent paths are blocked: agent tokens and the agent WebSocket are never reachable
  through a user session.
* **Route protection.** `src/proxy.ts` (Next.js 16 proxy, formerly middleware) redirects to
  `/login?next=…` without a session cookie. Every API call is authorised by Chronos itself.
  A `401` anywhere clears the cookie and returns the user to sign-in.
* **Real-time.** `EventSource` on `/api/chronos/v1/projects/:id/events`, which is the Chronos
  dashboard Server-Sent Events stream, not the agent WebSocket. Events patch and invalidate
  TanStack Query caches. Duplicates are ignored, and everything is refetched after a reconnect (no
  replay). While the stream is unavailable, pages poll every 15 s.
* **State.** Server data lives in TanStack Query. Zustand holds only the selected
  organization/project, the sidebar preference, and session notifications.

## Running

```bash
cp apps/dashboard/.env.example apps/dashboard/.env.local   # CHRONOS_API_URL=http://127.0.0.1:8080
pnpm dev:dashboard                                         # http://localhost:3000
pnpm --filter @chronos/dashboard build && pnpm --filter @chronos/dashboard start
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `CHRONOS_API_URL` | – (required) | Chronos API base URL **as seen from the dashboard server**, without `/v1` |
| `DASHBOARD_SECURE_COOKIES` | `true` in production | Set `false` only when serving the dashboard over plain `http://` |
| `NEXT_PUBLIC_CHRONOS_PUBLIC_URL` | – | Public API URL shown in SDK snippets (display only) |

The specification suggested `NEXT_PUBLIC_CHRONOS_API_URL=http://localhost:4000/api/v1`. The
real API listens on `:8080` with prefix `/v1`. Because of the cookie-based design the browser
never calls it, so the URL is a server-side variable (`CHRONOS_API_URL`).

## Scripts

`pnpm --filter @chronos/dashboard <script>`: `dev`, `build`, `start`, `typecheck`, `lint`
(ESLint 9 flat config, typescript-eslint, Next and React-hooks rules, zero warnings), `test`
(Vitest + Testing Library, jsdom).

## Status

| Phase | Scope | State |
| --- | --- | --- |
| 1. Foundation | Next.js 16, Tailwind 4 design tokens (dark-first + light), shadcn-style UI kit on Radix, app shell (collapsible sidebar, mobile drawer, top bar, breadcrumbs), BFF auth (login, first-time setup, logout, route protection), API client and service layer, real-time provider, connection status, notification center | Done |
| 2. Overview and Jobs | Overview (10 summary cards, 7 charts, upcoming/recent/failed runs, queue/agent/worker health, activity), jobs list (search, filters, sort, pagination), 5-step create/edit wizard, job details (overview, executions, configuration, logs, activity), job actions | Done |
| 3. Queues | Queue list with live counts and 24 h statistics, create/edit/pause/resume/delete, queue details (state tabs, throughput, executors, activity), job inspector, immediate and delayed submission with countdown | Done |
| 4. Schedules and Executions | Month calendar (server-calculated occurrences and recorded runs), next-7-days list, scheduled jobs table, execution history with URL filters, execution details with attempt timeline and live log tail | Done |
| 5. Infrastructure | Agents and agent details (handlers, executions, credential revocation), workers and worker details, activity log | Done |
| 6. Settings | Profile and password, organization, members and roles, projects, API and agent credentials | Done |
| 7. Finalization | Global search (Ctrl/⌘ K), in-app documentation, skip link, Docker image and compose profile, tests, production build | Done |

The pages are client-rendered (the session lives in an httpOnly cookie that only the dashboard
server can read), and every view comes from the real API. No mock data is used anywhere.

## Docker

```bash
docker compose --env-file .env -f docker/compose.yaml --profile dashboard up -d --build
```

`docker/Dockerfile.dashboard` builds the Next.js standalone server (non-root, with a health check).
See docs/DEPLOYMENT_GUIDE.md, "Running the dashboard".

## Tests

`pnpm --filter @chronos/dashboard test` runs Vitest and Testing Library in jsdom. It covers:
- route protection, CSRF and the API proxy allowlist
- the API client and auth forms
- the job, queue and submission form models (immediate and delayed, including time-zone and DST conversion)
- list filtering and pagination, the execution timeline and calendar helpers
- permission-based UI (activity, credentials, members)
- the token-shown-once flow

Workers are capped at two because jsdom is memory-hungry.

## Backend capabilities and gaps

Everything the dashboard shows comes from real endpoints. These are the requested features and how they map
to the backend:

| Requested | Status |
| --- | --- |
| Login, logout, bootstrap, roles, members, projects, credentials (create/rotate/revoke), profile, password | Supported |
| Jobs CRUD, pause/resume, trigger, schedule preview, upcoming occurrences | Supported |
| Queues, immediate and delayed submission, priority, limits, pause, cancel before start | Supported |
| Executions list/detail/logs/cancel/retry, statistics, time series | Supported |
| Agents list/detail/remove, workers list, activity log, real-time stream | Supported |
| Per-queue statistics, executions by mode and kind, duration over time, last execution per job, execution filter by agent/worker, "executed by", worker detail, agent credential id | Added to the backend for the dashboard (read-only, covered by integration tests) |
| "Disconnect agent" | Revoking its credential disconnects it (no separate endpoint) |
| "Target a specific agent" | Not supported by design: any connected agent with the handler takes the work |
| Agent heartbeat history, agent logs | Not stored by the backend (only the last heartbeat) |
| Member invitations (email) | Not supported: admins add existing users or create users with an initial password |
| Notification preferences (email/Slack alerts) | Not supported by the backend. The dashboard shows in-session notifications from the event stream only |
| Bulk "clear queue" | No bulk endpoint; executions are cancelled individually |
| Job types | Chronos jobs are definitions. A schedule (cron or one-time) makes them run by themselves, and *immediate* and *delayed* are ways of **submitting** a job (`POST /queue`), not job properties. The dashboard shows a job's type as Cron / One-time / On demand, and each execution's kind as Scheduled / Manual / Immediate / Delayed |
| Global search | Built from real endpoints: job search (`?q=`), execution lookup by id, and the complete queue, agent, worker and project lists |
