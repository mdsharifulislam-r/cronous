import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Redis } from 'ioredis';
import { PrismaClient } from '@chronos/database';
import { TEST_DATABASE_URL, TEST_REDIS_URL } from './test-env';

const HELP =
  'Integration tests need PostgreSQL and Redis. Start them with `pnpm infra:test:up` ' +
  '(docker/compose.test.yaml) or point CHRONOS_TEST_DATABASE_URL / CHRONOS_TEST_REDIS_URL at your own instances.';

/**
 * Prepares a clean schema once per run. Fails loudly (never skips) when the
 * infrastructure is unreachable, so missing infrastructure cannot look like a pass.
 */
export default async function globalSetup(): Promise<void> {
  if (!/_test\b|test$/i.test(new URL(TEST_DATABASE_URL).pathname)) {
    throw new Error(`Refusing to reset "${TEST_DATABASE_URL}": the database name must end in "test" or "_test".`);
  }

  const redis = new Redis(TEST_REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0, connectTimeout: 3000 });
  try {
    await redis.connect();
    await redis.ping();
  } catch (error) {
    throw new Error(`Redis unreachable at ${TEST_REDIS_URL}: ${String(error)}\n${HELP}`);
  } finally {
    redis.disconnect();
  }

  const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  try {
    await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await prisma.$executeRawUnsafe('CREATE SCHEMA public');
  } catch (error) {
    throw new Error(`PostgreSQL unreachable at ${TEST_DATABASE_URL}: ${String(error)}\n${HELP}`);
  } finally {
    await prisma.$disconnect();
  }

  // Apply the real migrations (not `db push`) so the migration SQL itself is tested.
  const databaseDir = path.resolve(__dirname, '../../../../packages/database');
  const prismaCli = require.resolve('prisma/build/index.js', { paths: [databaseDir] });
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: databaseDir,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'pipe',
  });
}
