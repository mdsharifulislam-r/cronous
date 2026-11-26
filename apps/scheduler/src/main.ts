import { Queue } from 'bullmq';
import { z } from 'zod';
import { createPrismaClient } from '@chronos/database';
import {
  ExecutionQueues,
  SchedulerRuntime,
  agentWorkChannel,
  baseProcessEnvSchema,
  createProcessLogger,
  createRedisConnection,
  dispatchWakeChannel,
  onShutdownSignal,
  pinoEngineLogger,
  startHealthServer,
} from '@chronos/engine';
import { EnvValidationError, Keyspace, parseEnv } from '@chronos/shared';

const envSchema = baseProcessEnvSchema.extend({
  CHRONOS_SCHEDULER_TICK_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
  CHRONOS_EXECUTION_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(30),
  CHRONOS_AGENT_HEARTBEAT_MS: z.coerce.number().int().min(1000).max(120_000).default(10_000),
});

async function main(): Promise<void> {
  let env: z.output<typeof envSchema>;
  try {
    env = parseEnv(envSchema);
  } catch (error) {
    process.stderr.write(`${error instanceof EnvValidationError ? error.message : String(error)}\n`);
    process.exit(1);
  }

  const logger = createProcessLogger('chronos-scheduler', env.LOG_LEVEL, env.LOG_PRETTY);
  const keyspace = new Keyspace(env.CHRONOS_NAMESPACE);
  const prisma = createPrismaClient({ url: env.DATABASE_URL });
  await prisma.$connect();

  const command = createRedisConnection(env.REDIS_URL, 'command', `${env.CHRONOS_NAMESPACE}:scheduler:command`);
  const queues = new Map<string, Queue>();
  const executionQueues = new ExecutionQueues((name) => {
    let queue = queues.get(name);
    if (!queue) {
      queue = new Queue(name, {
        prefix: keyspace.bullPrefix,
        connection: createRedisConnection(env.REDIS_URL, 'producer', `${env.CHRONOS_NAMESPACE}:scheduler:producer`),
      });
      queue.on('error', (error: Error) => logger.error({ queue: name, err: error.message }, 'Queue error'));
      queues.set(name, queue);
    }
    return queue;
  });

  const runtime = new SchedulerRuntime(
    {
      prisma,
      queues: executionQueues,
      notifyAgents: async (projectIds) => {
        await Promise.all(projectIds.map((id) => command.publish(agentWorkChannel(keyspace, id), '1')));
      },
      logger: pinoEngineLogger(logger),
    },
    {
      tickMs: env.CHRONOS_SCHEDULER_TICK_MS,
      batchSize: 100,
      reapIntervalMs: 5000,
      queuedStaleMs: 60_000,
      reaper: {
        timeoutGraceMs: 30_000,
        agentStaleMs: env.CHRONOS_AGENT_HEARTBEAT_MS * 4,
        workerStaleMs: 60_000,
        retentionDays: env.CHRONOS_EXECUTION_RETENTION_DAYS,
        batchSize: 100,
      },
    },
  );

  const health = startHealthServer(
    env.CHRONOS_HEALTH_PORT,
    [
      { name: 'postgres', check: async () => void (await prisma.$queryRaw`SELECT 1`) },
      { name: 'redis', check: async () => void (await command.ping()) },
    ],
    logger,
  );

  runtime.start();

  // Submissions due now publish a wake-up so they are dispatched without waiting a tick.
  const wakeSubscriber = createRedisConnection(env.REDIS_URL, 'subscriber', `${env.CHRONOS_NAMESPACE}:scheduler:wake`);
  wakeSubscriber.on('message', () => runtime.wake());
  await wakeSubscriber.subscribe(dispatchWakeChannel(keyspace)).catch((error: unknown) =>
    logger.warn({ err: String(error) }, 'Dispatch wake-up subscription failed; relying on the tick'),
  );

  onShutdownSignal(
    async () => {
      await runtime.stop();
      await wakeSubscriber.quit().catch(() => wakeSubscriber.disconnect());
      await Promise.allSettled([...queues.values()].map((queue) => queue.close()));
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
