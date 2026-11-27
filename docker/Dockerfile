# syntax=docker/dockerfile:1.7
# Chronos image: the server (API, agent gateway, dashboard, embedded scheduler and webhook
# worker) plus the standalone scheduler and worker entrypoints. Build from the repo root:
#   docker build -f docker/Dockerfile -t chronos-server .
# Entrypoints:
#   node dist/main.js               server (default)
#   node bin/scheduler/main.js      standalone scheduler
#   node bin/worker/main.js         central worker (Mode C) / webhook worker
#   /app/bin/migrate                apply database migrations and exit
# Set CHRONOS_MIGRATE_ON_START=true to apply migrations before any of the above.
# Pin NODE_IMAGE to a digest in production builds.
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /repo

# ---------------------------------------------------------------------------
FROM base AS build
# Manifests first so the dependency layer is cached across source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc turbo.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/scheduler/package.json apps/scheduler/
COPY apps/worker/package.json apps/worker/
COPY apps/dashboard-lite/package.json apps/dashboard-lite/
COPY packages/shared/package.json packages/shared/
COPY packages/database/package.json packages/database/
COPY packages/protocol/package.json packages/protocol/
COPY packages/engine/package.json packages/engine/
COPY packages/sdk/package.json packages/sdk/
COPY examples/sdk-app/package.json examples/sdk-app/
# The Next.js dashboard (apps/dashboard) has its own image (docker/Dockerfile.dashboard).
# --ignore-scripts: no install script is needed for this build (Prisma downloads its engines
# in `prisma generate`), and @swc/core's postinstall (used only by the server's tests) crashes
# on linux/arm64.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter='!@chronos/dashboard'

COPY packages packages
COPY apps apps
RUN pnpm turbo run build --filter=@chronos/server... --filter=@chronos/scheduler... --filter=@chronos/worker...

# Self-contained production tree (workspace packages copied in, dev deps dropped).
RUN pnpm --filter=@chronos/server deploy --prod /out/server
# The scheduler and worker only use packages the server already depends on, so their
# compiled code runs against the server's node_modules.
RUN mkdir -p /out/server/bin \
  && cp -r apps/scheduler/dist /out/server/bin/scheduler \
  && cp -r apps/worker/dist /out/server/bin/worker \
  && cp -r apps/worker/examples /out/server/bin/worker/examples
# The generated Prisma client is not part of any package tarball; regenerate it inside
# the deployed tree so it sits next to the @prisma/client that runtime code resolves.
RUN cd /out/server \
  && DB_DIR="$(node -p "require('path').dirname(require.resolve('@chronos/database/package.json'))")" \
  && cd "$DB_DIR" \
  && node "$(node -p "require.resolve('prisma/build/index.js')")" generate

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /out/server /app
COPY --chown=node:node --chmod=0755 docker/migrate.sh /app/bin/migrate
COPY --chown=node:node --chmod=0755 docker/entrypoint.sh /app/bin/entrypoint
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/app/bin/entrypoint"]
CMD ["node", "dist/main.js"]
