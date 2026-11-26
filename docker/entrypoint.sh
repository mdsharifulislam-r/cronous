#!/bin/sh
# Container entrypoint. With CHRONOS_MIGRATE_ON_START=true, applies pending database
# migrations before starting the command (handy for single `docker run` deployments;
# concurrent starts are safe, Prisma serialises migrations with an advisory lock).
set -eu
if [ "${CHRONOS_MIGRATE_ON_START:-false}" = "true" ]; then
  /app/bin/migrate
fi
exec "$@"
