# Deploying Chronos

All commands run from the repository root. Compose reads variables from `.env` through
`--env-file`. Every variable is described in
[ENVIRONMENT_CONFIGURATION.md](ENVIRONMENT_CONFIGURATION.md).

```bash
cp .env.example .env
# generate secrets:  openssl rand -hex 32
```

Passwords inside `DATABASE_URL` and `REDIS_URL` must be URL-safe (hex is) or
percent-encoded.

## Option A: bundled PostgreSQL and Redis

This starts PostgreSQL 17, Redis 7.4 (AOF persistence, `noeviction`, password), a one-shot
migration container, and the server.

```bash
# .env: set POSTGRES_PASSWORD and REDIS_PASSWORD
docker compose --env-file .env -f docker/compose.yaml up -d --build
docker compose --env-file .env -f docker/compose.yaml logs server | grep -A3 "bootstrap token"
```

* Data lives in the named volumes `postgres-data` and `redis-data`.
* Neither PostgreSQL nor Redis is published to the host.
* The API is published on `127.0.0.1:8080` (`CHRONOS_HTTP_BIND`, `CHRONOS_HTTP_PORT`).

## Option B: existing PostgreSQL and Redis

```bash
# .env: set DATABASE_URL and REDIS_URL
docker compose --env-file .env -f docker/compose.external.yaml up -d --build
```

The migration container runs `prisma migrate deploy`. It is idempotent and safe to
run on every deploy. Create a dedicated database and user for Chronos:

```sql
CREATE USER chronos WITH PASSWORD '...';
CREATE DATABASE chronos OWNER chronos;
```

Redis can be shared with your applications: Chronos namespaces every key and queue under
`CHRONOS_NAMESPACE` (default `chronos`). Use a dedicated logical database
(`redis://…/3`) if you want stronger separation. Redis **must** use
`maxmemory-policy noeviction`; the server logs a warning at startup if it does not.

### Attaching to an existing Docker network

If PostgreSQL, Redis or your applications run in containers on an existing network:

```bash
# .env
CHRONOS_EXTERNAL_NETWORK=my_app_network
DATABASE_URL=postgresql://chronos:...@my-postgres:5432/chronos
REDIS_URL=redis://:...@my-redis:6379/3

docker compose --env-file .env -f docker/compose.external.yaml -f docker/compose.network.yaml up -d --build
```

Your applications on that network then reach Chronos at `http://chronos-server-1:8080`
(or give the service an alias), and no published port is needed.

## Topologies

| Topology | Application → Chronos | Chronos → Postgres/Redis |
| --- | --- | --- |
| Same VPS, same Docker network | `http://<service>:8080` on the shared network | container names |
| Same VPS, different networks | `http://127.0.0.1:8080` (published on loopback) | bundled or host IPs |
| Separate VPS | `https://chronos.example.com` through a TLS reverse proxy | private network / VPN; `sslmode=require`, `rediss://` |

For separate hosts, terminate TLS in a reverse proxy (Caddy, nginx, Traefik) in front of
Chronos and set `CHRONOS_TRUST_PROXY=true`. The agent channel (Mode B) is an outbound
WSS connection from the application, so applications never need an inbound port.
**Never expose Redis or PostgreSQL to the internet.**

### Reverse proxy requirements

Two long-lived channels pass through the proxy:

* **Agent WebSocket** `/v1/agent/ws`: the proxy must forward `Upgrade` and `Connection`.
* **Dashboard event stream** `/v1/projects/:id/events`: the proxy must not buffer it and must not
  time it out. The server sends a keepalive comment every 15 s.

Caddy and Traefik handle both without extra configuration. For nginx:

```nginx
location /v1/agent/ws {
    proxy_pass http://chronos;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 120s;
}
location ~ ^/v1/projects/[^/]+/events$ {
    proxy_pass http://chronos;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 1h;
}
location / {
    proxy_pass http://chronos;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

### Rate limits and client addresses

The API limits requests per token, per client address without a token, and per address that
presents unknown tokens (see `CHRONOS_RATE_LIMIT_*`). Address-based limits need the real
client address:

* **Behind your own reverse proxy or the Next.js dashboard:** set `CHRONOS_TRUST_PROXY=true`.
  Every user then has their own address budget instead of sharing the proxy's. The dashboard
  forwards `X-Forwarded-For`.
* **Never enable it when the API is reachable directly.** Clients could forge the header.

Token-based limits (the main ones) do not depend on this.

### Running the dashboard

The full dashboard (`apps/dashboard`, Next.js) runs as its own container and talks to the API
over the internal network. Its session lives in an httpOnly cookie, so the API needs no CORS
configuration.

```bash
docker compose --env-file .env -f docker/compose.yaml --profile dashboard up -d --build
# http://127.0.0.1:3000  (CHRONOS_DASHBOARD_BIND / CHRONOS_DASHBOARD_PORT)
```

* Serve it over HTTPS through your reverse proxy in production. The session cookie is
  `Secure` by default (`DASHBOARD_SECURE_COOKIES=true`). Browsers accept that on `https://`
  and on `http://localhost` / `127.0.0.1`. Set it to `false` only for plain HTTP on another
  host name.
* The proxy must not buffer `/api/chronos/v1/projects/*/events` (Server-Sent Events). The
  nginx settings above apply to that path on the dashboard host as well.
* The lightweight UI served by the API at `/dashboard` (`apps/dashboard-lite`) remains
  available. Set `CHRONOS_DASHBOARD_ENABLED=false` on the server to turn it off.

### Connecting a separate dashboard

There are two ways to connect a separately hosted dashboard (for example Next.js):

* **Recommended:** call Chronos from the dashboard's server side (route handlers) over a
  private network. No CORS configuration is needed.
* **Browser calls Chronos directly:** set `CHRONOS_CORS_ORIGINS=https://dashboard.example.com`.

See [DASHBOARD_INTEGRATION.md](DASHBOARD_INTEGRATION.md). Set `CHRONOS_DASHBOARD_ENABLED=false`
to stop serving the bundled UI.

## First-time setup

1. Read the bootstrap token from the server log, or set `CHRONOS_BOOTSTRAP_TOKEN` yourself
   before the first start.
2. Bootstrap:

   ```bash
   curl -sS -X POST http://127.0.0.1:8080/v1/bootstrap \
     -H "Authorization: Bearer $BOOTSTRAP_TOKEN" -H 'Content-Type: application/json' \
     -d '{
       "admin": {"email": "you@example.com", "name": "You", "password": "a-long-passphrase"},
       "organization": {"name": "Acme", "slug": "acme"},
       "project": {"name": "Storefront", "slug": "storefront", "timezone": "Asia/Dhaka"}
     }'
   ```

3. Store the returned `projectKey` and `agentToken` in your secret manager. They are shown
   once. The bootstrap token is now permanently invalid.

If you lose a generated bootstrap token before using it, set `CHRONOS_BOOTSTRAP_TOKEN` and
restart. The stored hash is replaced.

## Workers, scaling and execution settings

The server container is a complete install: it embeds the scheduler loop and a webhook
(HTTP) worker. Add containers only when you need them.

**Central workers (Mode C).** Put your handler module in a directory and start the
`workers` profile:

```bash
# .env
CHRONOS_WORKER_HANDLERS_DIR=/srv/chronos-handlers     # contains handlers.js
CHRONOS_WORKER_CONCURRENCY=10
docker compose --env-file .env -f docker/compose.yaml --profile workers up -d
docker compose --env-file .env -f docker/compose.yaml --profile workers up -d --scale worker=3
```

Workers can run on other hosts. Run the same image with `node bin/worker/main.js` and
point `DATABASE_URL` and `REDIS_URL` at your infrastructure over a private network. Workers
are trusted components (they hold database credentials), so mount only trusted code.
To run webhook delivery on dedicated workers, set `CHRONOS_WORKER_MODES=HTTP,WORKER` on
them and `CHRONOS_EMBEDDED_WORKER=false` on the server.

**Standalone scheduler.** `--profile scale` starts `bin/scheduler/main.js`. Set
`CHRONOS_EMBEDDED_SCHEDULER=false` on the server if scheduling should run only there.
Running several schedulers, or several servers with embedded schedulers, is safe: they
coordinate through PostgreSQL row locks.

**Server replicas.** Any number of server replicas can run behind a load balancer. Agents
and event streams may connect to any of them. Each replica with open event streams polls the
database once per `CHRONOS_EVENTS_POLL_MS`.

## Health checks

* `GET /health/live`: process liveness, no dependency checks. Use it for restarts.
* `GET /health/ready`: PostgreSQL and Redis reachable within
  `CHRONOS_READINESS_TIMEOUT_MS`; returns `503` otherwise. Use it for load-balancer routing.
* Standalone scheduler and worker containers expose the same two paths on
  `CHRONOS_HEALTH_PORT` (default 8081).

## Upgrades

```bash
git pull
docker compose --env-file .env -f docker/compose.yaml up -d --build
```

Migrations run (`prisma migrate deploy`) before the new server starts. Migration
`20261126000000_dashboard_support` only adds two indexes. On very large `job_executions`
tables, `CREATE INDEX` locks writes to the table while it builds. Run the upgrade in a quiet period,
or create the index beforehand with `CREATE INDEX CONCURRENTLY` under the same name. The server
stops gracefully on `SIGTERM` (`stop_grace_period: 30s`, internal limit
`CHRONOS_SHUTDOWN_TIMEOUT_MS`).

## Backups

Back up PostgreSQL: it holds all definitions, history, credentials (hashed) and webhook
secrets (**not encrypted at rest**; protect backups accordingly). Redis holds only
transient delivery state. After restoring PostgreSQL without Redis, the dispatcher re-enqueues
`QUEUED` executions that went stale, so no work is lost.
