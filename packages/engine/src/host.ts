import { createServer, Server } from 'node:http';
import { Redis, RedisOptions } from 'ioredis';
import pino, { Logger } from 'pino';
import { z } from 'zod';
import { envBoolean, isValidNamespace } from '@chronos/shared';
import type { EngineLogger } from './common';

/**
 * Process plumbing shared by the standalone scheduler and worker apps: validated base
 * configuration, a pino logger, Redis connections with the right retry semantics, a
 * health endpoint and signal handling.
 */
export const baseProcessEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: envBoolean(false),
  DATABASE_URL: z.string().url().refine((value) => /^postgres(ql)?:\/\//.test(value), 'must be a postgres:// URL'),
  REDIS_URL: z.string().url().refine((value) => /^rediss?:\/\//.test(value), 'must be a redis:// or rediss:// URL'),
  CHRONOS_NAMESPACE: z.string().default('chronos').refine(isValidNamespace, 'must match ^[a-z][a-z0-9_-]{0,31}$'),
  CHRONOS_HEALTH_PORT: z.coerce.number().int().min(0).max(65535).default(8081),
  CHRONOS_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(30_000),
});

export function createProcessLogger(name: string, level: string, pretty: boolean): Logger {
  return pino({
    name,
    level,
    ...(pretty ? { transport: { target: 'pino-pretty', options: { singleLine: true } } } : {}),
  });
}

export function pinoEngineLogger(logger: Logger): EngineLogger {
  return {
    debug: (message, context) => logger.debug(context ?? {}, message),
    info: (message, context) => logger.info(context ?? {}, message),
    warn: (message, context) => logger.warn(context ?? {}, message),
    error: (message, context) => logger.error(context ?? {}, message),
  };
}

/** `command`/`producer` connections fail fast; `worker` connections retry forever (BullMQ requirement). */
export function createRedisConnection(url: string, role: 'command' | 'producer' | 'worker' | 'subscriber', name: string): Redis {
  const options: RedisOptions = {
    connectionName: name,
    connectTimeout: 5000,
    retryStrategy: (attempt: number) => Math.min(100 * 2 ** Math.min(attempt, 6), 5000),
    ...(role === 'worker' || role === 'subscriber'
      ? { maxRetriesPerRequest: null }
      : role === 'producer'
        ? { maxRetriesPerRequest: 1, enableOfflineQueue: false }
        : { maxRetriesPerRequest: 2 }),
  };
  const connection = new Redis(url, options);
  connection.on('error', () => undefined); // surfaced via readiness checks
  return connection;
}

export interface HealthCheck {
  name: string;
  check: () => Promise<void>;
}

/** Minimal /health/live and /health/ready endpoint for orchestrators. */
export function startHealthServer(port: number, checks: HealthCheck[], logger: Logger): Server {
  const server = createServer((request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (request.url === '/health/live') return send(200, { status: 'alive' });
    if (request.url === '/health/ready') {
      void Promise.all(
        checks.map(async ({ name, check }) => {
          try {
            await Promise.race([check(), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))]);
            return [name, 'up'] as const;
          } catch {
            return [name, 'down'] as const;
          }
        }),
      ).then((results) => {
        const ready = results.every(([, status]) => status === 'up');
        send(ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready', checks: Object.fromEntries(results) });
      });
      return;
    }
    send(404, { error: 'not found' });
  });
  server.listen(port, () => logger.info({ port }, 'Health endpoint listening'));
  return server;
}

/** Runs `shutdown` once on SIGTERM/SIGINT, forcing exit if it exceeds `timeoutMs`. */
export function onShutdownSignal(shutdown: () => Promise<void>, timeoutMs: number, logger: Logger): void {
  let shuttingDown = false;
  const handler = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down gracefully');
    setTimeout(() => {
      logger.error({ timeoutMs }, 'Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, timeoutMs).unref();
    shutdown()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error({ err: error }, 'Error during shutdown');
        process.exit(1);
      });
  };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
}
