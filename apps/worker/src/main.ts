import { z } from 'zod';
import { createPrismaClient } from '@chronos/database';
import {
  HttpExecutor,
  WorkerRuntime,
  baseProcessEnvSchema,
  createProcessLogger,
  createRedisConnection,
  onShutdownSignal,
  pinoEngineLogger,
  startHealthServer,
} from '@chronos/engine';
import { EnvValidationError, Keyspace, envBoolean, parseEnv } from '@chronos/shared';
import { loadHandlers } from './handlers';

const envSchema = baseProcessEnvSchema.extend({
  /** Which queues to consume: "HTTP", "WORKER" or both (comma-separated). */
  CHRONOS_WORKER_MODES: z
    .string()
    .default('WORKER')
    .transform((value) => value.split(',').map((mode) => mode.trim().toUpperCase()))
    .pipe(z.array(z.enum(['HTTP', 'WORKER'])).min(1)),
  CHRONOS_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(1000).default(10),
  CHRONOS_WORKER_HANDLERS: z.string().optional(),
  CHRONOS_LEASE_MS: z.coerce.number().int().min(5000).max(600_000).default(30_000),
  CHRONOS_WEBHOOK_ALLOW_PRIVATE: envBoolean(true),
  CHRONOS_WEBHOOK_ALLOWED_CIDRS: z.string().optional().transform((value) => (value ? value.split(',').map((cidr) => cidr.trim()).filter(Boolean) : [])),
});

async function main(): Promise<void> {
  let env: z.output<typeof envSchema>;
  try {
    env = parseEnv(envSchema);
  } catch (error) {
    process.stderr.write(`${error instanceof EnvValidationError ? error.message : String(error)}\n`);
    process.exit(1);
  }

  const logger = createProcessLogger('chronos-worker', env.LOG_LEVEL, env.LOG_PRETTY);
  const handlers = loadHandlers(env.CHRONOS_WORKER_HANDLERS);
  if (env.CHRONOS_WORKER_MODES.includes('WORKER') && Object.keys(handlers).length === 0) {
    logger.warn('WORKER mode is enabled but no handlers were loaded (set CHRONOS_WORKER_HANDLERS)');
  }

  const prisma = createPrismaClient({ url: env.DATABASE_URL });
  await prisma.$connect();
  const command = createRedisConnection(env.REDIS_URL, 'command', `${env.CHRONOS_NAMESPACE}:worker:command`);
  const http = new HttpExecutor({ allowPrivate: env.CHRONOS_WEBHOOK_ALLOW_PRIVATE, allowedCidrs: env.CHRONOS_WEBHOOK_ALLOWED_CIDRS });

  const runtime = new WorkerRuntime(
    {
      prisma,
      keyspace: new Keyspace(env.CHRONOS_NAMESPACE),
      workerConnection: () => createRedisConnection(env.REDIS_URL, 'worker', `${env.CHRONOS_NAMESPACE}:worker:consumer`),
      http,
      handlers,
      logger: pinoEngineLogger(logger),
    },
    {
      modes: env.CHRONOS_WORKER_MODES,
      concurrency: env.CHRONOS_WORKER_CONCURRENCY,
      leaseMs: env.CHRONOS_LEASE_MS,
      heartbeatMs: 10_000,
      version: '0.1.0',
    },
  );
  await runtime.start();
  logger.info({ handlers: Object.keys(handlers) }, 'Loaded worker handlers');

  const health = startHealthServer(
    env.CHRONOS_HEALTH_PORT,
    [
      { name: 'postgres', check: async () => void (await prisma.$queryRaw`SELECT 1`) },
      { name: 'redis', check: async () => void (await command.ping()) },
    ],
    logger,
  );

  onShutdownSignal(
    async () => {
      await runtime.stop();
      await http.close();
      health.close();
      await command.quit().catch(() => command.disconnect());
      await prisma.$disconnect();
    },
    env.CHRONOS_SHUTDOWN_TIMEOUT_MS,
    logger,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`Fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
