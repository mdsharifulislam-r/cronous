#!/bin/sh
# Applies pending Prisma migrations (idempotent). Runs as a one-shot container before
# the server starts. Requires DATABASE_URL.
set -eu
: "${DATABASE_URL:?DATABASE_URL is required}"
cd /app
DB_DIR="$(node -p "require('path').dirname(require.resolve('@chronos/database/package.json'))")"
cd "$DB_DIR"
exec node "$(node -p "require.resolve('prisma/build/index.js')")" migrate deploy
