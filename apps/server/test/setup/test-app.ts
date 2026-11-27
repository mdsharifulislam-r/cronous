import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createApp } from '../../src/app.factory';
import { ServerEnv, loadServerEnv } from '../../src/config/env.schema';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { RedisService } from '../../src/infrastructure/redis/redis.service';
import { BootstrapService } from '../../src/modules/bootstrap/bootstrap.service';
import { TEST_BOOTSTRAP_TOKEN, TEST_DATABASE_URL, TEST_NAMESPACE, TEST_REDIS_URL } from './test-env';

export function testConfig(overrides: Record<string, string | undefined> = {}): ServerEnv {
  return loadServerEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: TEST_DATABASE_URL,
    REDIS_URL: TEST_REDIS_URL,
    CHRONOS_NAMESPACE: TEST_NAMESPACE,
    CHRONOS_BOOTSTRAP_TOKEN: TEST_BOOTSTRAP_TOKEN,
    // Tests drive scheduler cycles and workers explicitly for determinism.
    CHRONOS_EMBEDDED_SCHEDULER: 'false',
    CHRONOS_EMBEDDED_WORKER: 'false',
    // Suites issue bursts of requests from one address; rate-limit.int-spec enables it explicitly.
    CHRONOS_RATE_LIMIT_ENABLED: 'false',
    ...overrides,
  });
}

/** Removes all rows (keeping the schema and migrations) and Chronos' Redis keys. */
export async function resetState(app: NestExpressApplication): Promise<void> {
  const prisma = app.get(PrismaService);
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = tables.map((table) => `"public"."${table.tablename}"`).join(', ');
  // An app started with background services (embedded scheduler) may be querying while we
  // truncate; PostgreSQL then aborts one side with a deadlock. Retry until the reset wins.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
      break;
    } catch (error) {
      if (attempt >= 5 || !isDeadlock(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
  await prisma.$executeRawUnsafe(`INSERT INTO system_state (id, created_at, updated_at) VALUES (1, now(), now())`);

  // Only delete our namespace: never FLUSHDB a Redis that may be shared.
  const redis = app.get(RedisService);
  let cursor = '0';
  do {
    const [next, keys] = await redis.client.scan(cursor, 'MATCH', redis.keyspace.pattern, 'COUNT', 500);
    if (keys.length > 0) await redis.client.del(...keys);
    cursor = next;
  } while (cursor !== '0');
}

function isDeadlock(error: unknown): boolean {
  const meta = (error as { meta?: { code?: string } } | null)?.meta;
  return meta?.code === '40P01' || (error instanceof Error && error.message.includes('deadlock detected'));
}

export async function startTestApp(overrides: Record<string, string | undefined> = {}): Promise<NestExpressApplication> {
  const app = await createApp(testConfig(overrides));
  try {
    await app.init();
    await resetState(app);
    // init() already ran the bootstrap hook; the reset wiped its state, so run it again.
    await app.get(BootstrapService).ensureBootstrapToken();
  } catch (error) {
    // Never leak a half-started app: its background loops would keep running in this test
    // process and take work from the suites that follow.
    await app.close().catch(() => undefined);
    throw error;
  }
  return app;
}

export function api(app: NestExpressApplication) {
  return request(app.getHttpServer());
}

export const ADMIN = { email: 'admin@example.com', name: 'Admin', password: 'correct-horse-battery' };

export interface BootstrapResult {
  user: { id: string; email: string };
  organization: { id: string; slug: string };
  project: { id: string; slug: string; timezone: string };
  credentials: {
    userToken: { token: string };
    projectKey: { id: string; token: string };
    agentToken: { id: string; token: string };
  };
}

export async function bootstrapInstallation(app: NestExpressApplication): Promise<BootstrapResult> {
  const response = await api(app)
    .post('/v1/bootstrap')
    .set('Authorization', `Bearer ${TEST_BOOTSTRAP_TOKEN}`)
    .send({
      admin: ADMIN,
      organization: { name: 'Acme', slug: 'acme' },
      project: { name: 'Storefront', slug: 'storefront', timezone: 'Asia/Dhaka' },
    });
  if (response.status !== 201) throw new Error(`bootstrap failed: ${response.status} ${JSON.stringify(response.body)}`);
  return response.body.data as BootstrapResult;
}

export function bearer(token: string): [string, string] {
  return ['Authorization', `Bearer ${token}`];
}
