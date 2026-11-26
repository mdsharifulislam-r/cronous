import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@chronos/database';
import { APP_CONFIG } from '../../config/config.module';
import { ServerEnv } from '../../config/env.schema';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PrismaService.name);

  constructor(@Inject(APP_CONFIG) config: ServerEnv) {
    super({
      datasources: { db: { url: config.DATABASE_URL } },
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });
    this.$on('warn' as never, (event: { message: string }) => this.logger.warn(event.message));
    this.$on('error' as never, (event: { message: string }) => this.logger.error(event.message));
  }

  async onModuleInit(): Promise<void> {
    // Connect eagerly so a wrong DATABASE_URL fails at startup, not on first request.
    await this.$connect();
    this.logger.log('Connected to PostgreSQL');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Disconnected from PostgreSQL');
  }

  /** Lightweight connectivity probe used by readiness checks. */
  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }
}
