import { Inject, Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { HttpExecutor, WorkerRuntime } from '@chronos/engine';
import { APP_CONFIG } from '../../config/config.module';
import { ServerEnv } from '../../config/env.schema';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { nestEngineLogger } from './engine-logger';

export const SERVER_VERSION = '0.1.0';

/**
 * Embedded worker for HTTP webhooks, so a single Chronos container can run Mode A.
 * Mode C (user code) runs in the separate `apps/worker` process instead.
 */
@Injectable()
export class WorkerHost implements OnApplicationBootstrap, OnModuleDestroy {
  readonly http: HttpExecutor;
  readonly runtime: WorkerRuntime;

  constructor(
    prisma: PrismaService,
    redis: RedisService,
    @Inject(APP_CONFIG) private readonly config: ServerEnv,
  ) {
    this.http = new HttpExecutor({ allowPrivate: config.CHRONOS_WEBHOOK_ALLOW_PRIVATE, allowedCidrs: config.CHRONOS_WEBHOOK_ALLOWED_CIDRS });
    this.runtime = new WorkerRuntime(
      {
        prisma,
        keyspace: redis.keyspace,
        workerConnection: () => redis.createConnection('worker'),
        http: this.http,
        logger: nestEngineLogger('Worker'),
      },
      {
        modes: ['HTTP'],
        concurrency: config.CHRONOS_WORKER_CONCURRENCY,
        leaseMs: config.CHRONOS_LEASE_MS,
        heartbeatMs: 10_000,
        version: SERVER_VERSION,
      },
    );
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.CHRONOS_EMBEDDED_WORKER) await this.runtime.start();
  }

  // Runs before queues and Redis connections are closed.
  async onModuleDestroy(): Promise<void> {
    if (this.config.CHRONOS_EMBEDDED_WORKER) await this.runtime.stop();
    await this.http.close();
  }
}
