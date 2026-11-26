# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-26

### Added

* **Scheduling:** cron and one-time schedules with time zones, DST-correct evaluation, misfire
  policies (fire once, skip, fire all) and overlap control.
* **Queue jobs:** immediate and delayed submissions (`chronos.queue()`, `POST /v1/projects/:id/queue`,
  batch), named queues with concurrency limits, priorities and pause/resume, per-job concurrency,
  JSON Schema payload validation, per-submission retry overrides, and cancellation before start.
* **Execution modes:** HTTP webhooks (signed, SSRF-protected), agents via `@chronos/sdk` over an
  outbound WebSocket, and central workers.
* **Reliability:** PostgreSQL as the source of truth, transactional outbox to BullMQ, `SKIP LOCKED`
  claiming, leases with fencing, retries with exponential backoff and jitter, dead letters and
  replay, and recovery from crashed workers, agents and schedulers. Delivery is at-least-once.
* **API:** organizations, projects, roles, credentials (rotation, revocation), jobs, executions, logs,
  statistics, activity log, schedule preview and calendar, and Server-Sent Events for dashboards.
* **Security:** hashed tokens, scrypt passwords, login lockout, revocation that disconnects live
  agents and event streams, per-token and per-address API rate limiting, and masked secrets that
  survive edits.
* **Dashboard:** a Next.js dashboard (`apps/dashboard`) with overview analytics, jobs, queues,
  schedules, executions, agents, workers, activity and settings, plus the lightweight built-in UI.
* **Deployment:** published multi-architecture images (`ghcr.io/mdsharifulislam-r/chronos`,
  `ghcr.io/mdsharifulislam-r/chronos-dashboard`) with optional migrations on start, Compose files for bundled or existing infrastructure, a health and
  readiness check, and documentation.
