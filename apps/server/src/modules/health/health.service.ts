import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import { ServerEnv } from '../../config/env.schema';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RedisService } from '../../infrastructure/redis/redis.service';

export interface DependencyCheck {
  status: 'up' | 'down';
  latencyMs: number;
  error?: string;
}

export interface ReadinessReport {
  status: 'ready' | 'not_ready';
  checks: { postgres: DependencyCheck; redis: DependencyCheck };
}

async function timed(probe: () => Promise<unknown>, timeoutMs: number): Promise<DependencyCheck> {
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      probe(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    return { status: 'up', latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    // Report the error class only: driver messages can include hostnames or credentials.
    const message = error instanceof Error && error.message.startsWith('timed out') ? error.message : 'unreachable';
    return { status: 'down', latencyMs: Math.round(performance.now() - started), error: message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Inject(APP_CONFIG) private readonly config: ServerEnv,
  ) {}

  async readiness(): Promise<ReadinessReport> {
    const timeoutMs = this.config.CHRONOS_READINESS_TIMEOUT_MS;
    const [postgres, redis] = await Promise.all([
      timed(() => this.prisma.ping(), timeoutMs),
      timed(() => this.redis.ping(timeoutMs), timeoutMs),
    ]);
    return { status: postgres.status === 'up' && redis.status === 'up' ? 'ready' : 'not_ready', checks: { postgres, redis } };
  }
}
