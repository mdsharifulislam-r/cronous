# Chronos Dashboard

The web dashboard for **[Chronos](https://hub.docker.com/r/cronouss/cronous)**, a self-hosted,
distributed job scheduler. Monitor and manage jobs, schedules, queues and executions in your
browser.

This image needs a running Chronos server ([`cronouss/cronous`](https://hub.docker.com/r/cronouss/cronous)).

* Source and docs: <https://github.com/mdsharifulislam-r/cronous>
* License: Apache-2.0

## Tags

| Tag | Meaning |
| --- | --- |
| `latest` | Newest release |
| `0.1`, `0.1.1`, … | A minor line, or an exact version. Use the same version as the server. |

Images are built for **linux/amd64** and **linux/arm64**.

## Where it fits

Your services submit jobs (`chronos.queue('send-email', data)`) and run handlers
(`chronos.task('send-email', fn)`). The Chronos server stores, schedules, delivers and retries
every execution. This dashboard shows all of it: what is waiting, running, failed or dead-lettered,
and who ran it. You can trigger, pause, retry or cancel from here. See
[How it works](https://hub.docker.com/r/cronouss/cronous) on the server image page.

## Features

* **Overview:** execution trends, success rates, durations, and upcoming runs
* **Jobs:** create and edit HTTP, agent and worker jobs. Trigger, pause and resume them, and preview cron schedules.
* **Queues:** live counts (waiting, delayed, running), pause/resume, concurrency limits, and submitting immediate or delayed jobs
* **Executions:** filter and search, inspect attempts and logs, retry, cancel and replay dead letters
* **Agents and workers:** connected SDK agents and central workers with live status
* **Settings:** members and roles, project credentials (rotate, revoke) and the activity log
* **Real time:** updates over Server-Sent Events, with polling as a fallback

## Docker Compose

Add the dashboard next to your Chronos server in `compose.yaml`:

```yaml
services:
  chronos:
    image: cronouss/cronous:0.1.1
    restart: unless-stopped
    environment:
      DATABASE_URL: postgresql://chronos:PASSWORD@postgres:5432/chronos
      REDIS_URL: redis://:PASSWORD@redis:6379/0
      CHRONOS_MIGRATE_ON_START: "true"
    ports:
      - "127.0.0.1:8080:8080"

  dashboard:
    image: cronouss/cronous-dashboard:0.1.1
    restart: unless-stopped
    environment:
      CHRONOS_API_URL: http://chronos:8080              # the server, as seen from this container
      CHRONOS_PUBLIC_URL: https://chronos.example.com   # optional: shown in SDK snippets
    ports:
      - "127.0.0.1:3000:3000"
    depends_on:
      chronos:
        condition: service_healthy
```

```bash
docker compose up -d
# open http://127.0.0.1:3000 and sign in with your Chronos account
```

The [`cronouss/cronous`](https://hub.docker.com/r/cronouss/cronous) page has a complete compose
file that includes PostgreSQL and Redis.

## Run with docker run

```bash
docker run -d --name chronos-dashboard --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -e CHRONOS_API_URL=http://chronos:8080 \
  -e CHRONOS_PUBLIC_URL=https://chronos.example.com \
  --network my-chronos-network \
  cronouss/cronous-dashboard:latest
```

`CHRONOS_API_URL` is the server's address **as seen from this container**, for example a
container name on a shared Docker network. The browser never talks to the API directly.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `CHRONOS_API_URL` | required | Chronos server base URL, without `/v1` (e.g. `http://chronos:8080`) |
| `CHRONOS_PUBLIC_URL` | empty | Public API URL shown in SDK and curl snippets |
| `DASHBOARD_SECURE_COOKIES` | `true` | Marks the session cookie `Secure`. Browsers accept it on `https://` and on `http://localhost`. Set `false` only for plain HTTP on another host name. |
| `PORT` | `3000` | Listen port |

## Security

* Sign in with your Chronos user account. The session token is stored in an **httpOnly** cookie
  and never reaches browser JavaScript. Requests are protected against CSRF.
* The API needs no CORS configuration for the dashboard: calls go through the dashboard's server.
* In production, serve it over HTTPS behind your reverse proxy, and turn off response buffering
  for `/api/chronos/v1/projects/*/events` (Server-Sent Events).

The image runs as the unprivileged `node` user, uses `tini` as init, and has a built-in
`HEALTHCHECK`.

More: [deployment guide](https://github.com/mdsharifulislam-r/cronous/blob/main/docs/DEPLOYMENT_GUIDE.md).
