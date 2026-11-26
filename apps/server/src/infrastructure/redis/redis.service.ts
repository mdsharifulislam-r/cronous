import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Redis, RedisOptions } from 'ioredis';
import { Keyspace } from '@chronos/shared';
import { APP_CONFIG } from '../../config/config.module';
import { ServerEnv } from '../../config/env.schema';

export type RedisConnectionRole = 'command' | 'producer' | 'worker' | 'subscriber';
export type RedisHealth = 'connecting' | 'ready' | 'reconnecting' | 'down' | 'closed';

const CONNECT_TIMEOUT_MS = 5000;
const MAX_RECONNECT_DELAY_MS = 5000;

/**
 * Owns every Redis connection the server opens.
 *
 * - `client` is the shared connection for regular commands (rate limits, locks, heartbeats).
 * - `createConnection('producer')` fails fast when Redis is unavailable, which is what
 *   BullMQ recommends for `Queue` instances (callers get an error instead of hanging).
 * - `createConnection('worker')` retries indefinitely (`maxRetriesPerRequest: null`),
 *   which BullMQ requires for `Worker` and blocking commands.
 *
 * All keys must be built with `keyspace` so Chronos can share a Redis instance safely.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);
  private readonly connections = new Set<Redis>();
  private health: RedisHealth = 'connecting';

  readonly keyspace: Keyspace;
  readonly client: Redis;

  constructor(@Inject(APP_CONFIG) private readonly config: ServerEnv) {
    this.keyspace = new Keyspace(config.CHRONOS_NAMESPACE);
    this.client = this.createConnection('command');
    this.trackHealth(this.client);
  }

  async onModuleInit(): Promise<void> {
    await this.waitUntilReady(this.client, CONNECT_TIMEOUT_MS * 2);
    await this.warnOnUnsafeEvictionPolicy();
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled(
      [...this.connections].map(async (connection) => {
        try {
          await connection.quit();
        } catch {
          connection.disconnect();
        }
      }),
    );
    this.connections.clear();
    this.health = 'closed';
    this.logger.log('Redis connections closed');
  }

  get status(): RedisHealth {
    return this.health;
  }

  /** Options for a new connection with the given role. Exposed for BullMQ wiring. */
  connectionOptions(role: RedisConnectionRole): RedisOptions {
    const common: RedisOptions = {
      connectionName: `${this.config.CHRONOS_NAMESPACE}:server:${role}`,
      connectTimeout: CONNECT_TIMEOUT_MS,
      lazyConnect: false,
      retryStrategy: (attempt: number) => Math.min(100 * 2 ** Math.min(attempt, 6), MAX_RECONNECT_DELAY_MS),
    };
    switch (role) {
      case 'worker':
      case 'subscriber':
        return { ...common, maxRetriesPerRequest: null, enableReadyCheck: true };
      case 'producer':
        return { ...common, maxRetriesPerRequest: 1, enableOfflineQueue: false };
      case 'command':
        return { ...common, maxRetriesPerRequest: 2 };
    }
  }

  /** Opens a new tracked connection. It is closed automatically on shutdown. */
  createConnection(role: RedisConnectionRole): Redis {
    const connection = new Redis(this.config.REDIS_URL, this.connectionOptions(role));
    connection.on('error', () => {
      // Errors are surfaced through health transitions; without a listener ioredis
      // would print unhandled error events for every reconnect attempt.
    });
    this.connections.add(connection);
    connection.once('end', () => this.connections.delete(connection));
    return connection;
  }

  /** Round-trip probe with a hard timeout, used by readiness checks. */
  async ping(timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const reply = await Promise.race([
        this.client.ping(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Redis ping timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
      if (reply !== 'PONG') throw new Error(`Unexpected PING reply: ${String(reply)}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private trackHealth(connection: Redis): void {
    // Log availability changes only; ioredis alternates down/reconnecting on every retry.
    const transition = (next: RedisHealth, detail?: string) => {
      const previous = this.health;
      if (previous === next) return;
      this.health = next;
      if (next === 'ready') {
        this.logger.log(previous === 'connecting' ? 'Connected to Redis' : 'Redis connection restored');
      } else if (next === 'down' && (previous === 'ready' || previous === 'connecting')) {
        this.logger.warn(`Redis unavailable${detail ? `: ${detail}` : ''}; reconnecting with backoff`);
      } else if (next === 'closed' && previous === 'ready') {
        this.logger.warn('Redis connection closed');
      }
    };
    connection.on('ready', () => transition('ready'));
    connection.on('reconnecting', () => transition('reconnecting'));
    connection.on('error', (error: Error) => transition('down', error.message));
    connection.on('end', () => transition('closed'));
  }

  private waitUntilReady(connection: Redis, timeoutMs: number): Promise<void> {
    if (connection.status === 'ready') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Redis did not become ready within ${timeoutMs}ms (check REDIS_URL)`));
      }, timeoutMs);
      const onReady = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        clearTimeout(timer);
        connection.off('ready', onReady);
      };
      connection.on('ready', onReady);
    });
  }

  /**
   * BullMQ loses jobs if Redis evicts keys under memory pressure. Managed Redis
   * offerings often disable CONFIG, so failure to read the setting is not fatal.
   */
  private async warnOnUnsafeEvictionPolicy(): Promise<void> {
    try {
      const reply = (await this.client.config('GET', 'maxmemory-policy')) as string[];
      const policy = reply[1];
      if (policy && policy !== 'noeviction') {
        this.logger.warn(
          `Redis maxmemory-policy is "${policy}". Chronos requires "noeviction"; queued deliveries may be lost under memory pressure.`,
        );
      }
    } catch {
      this.logger.debug('Could not read Redis maxmemory-policy (CONFIG command unavailable)');
    }
  }
}
