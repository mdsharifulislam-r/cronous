# Contributing to Chronos

Thanks for your interest! Bug reports, documentation fixes and pull requests are welcome.

## Before you start

* For anything larger than a small fix, open an issue first so we can agree on the approach.
* Security problems: follow [SECURITY.md](SECURITY.md), not the public tracker.
* By contributing you agree that your contribution is licensed under the
  [Apache License 2.0](LICENSE).

## Development setup

Requirements: Node.js >= 22.12, pnpm 9 (`corepack enable`), Docker.

```bash
pnpm install
pnpm build
pnpm infra:test:up            # PostgreSQL :55432 and Redis :56379 for tests (localhost only)
```

Run the server against them (see README, "Development"), and the dashboard with
`pnpm dev:dashboard` (`apps/dashboard/.env.local`: `CHRONOS_API_URL=http://127.0.0.1:8080`).

## Checks

Every pull request must pass the same checks CI runs:

```bash
pnpm typecheck
pnpm lint
pnpm test                     # unit tests
pnpm build
pnpm test:integration         # needs pnpm infra:test:up; never skipped
```

## Guidelines

* **Correctness first.** Chronos promises at-least-once delivery, leases and durable state. Changes
  to scheduling, dispatch, claiming or retries need integration tests against real PostgreSQL and
  Redis (`apps/server/test`).
* **Tests** accompany behaviour changes. Avoid sleeps: wait for observable state.
* **Database changes** come as a new Prisma migration (never edit an applied one) that works on
  populated databases.
* **API changes** update `docs/API_REFERENCE.md` (and `docs/WEBSOCKET_PROTOCOL.md` or
  `docs/QUEUE_JOBS.md` when relevant).
* **Dashboard** code uses the service layer (`apps/dashboard/src/services`) and shows real API data
  only.
* Keep commits focused, and write commit messages that explain *why*.

## Reporting bugs

Use the bug report template. Include the version or commit, the deployment type (Docker bundled,
external infrastructure, or local), what you expected, what happened, and the relevant log lines,
with request IDs if you have them.
