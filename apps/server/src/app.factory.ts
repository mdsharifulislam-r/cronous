import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { ServerEnv } from './config/env.schema';
import { apiSecurityHeaders, requestIdMiddleware } from './common/http/request-context';
import { mountDashboard } from './dashboard';
import { RateLimitService } from './modules/auth/rate-limit.service';

export const API_PREFIX = 'v1';

/** Builds a fully configured (not yet listening) application. Used by main.ts and tests. */
export async function createApp(config: ServerEnv): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
    bufferLogs: true,
    bodyParser: false,
  });
  app.useLogger(app.get(Logger));
  app.flushLogs();

  app.use(requestIdMiddleware);
  app.use(apiSecurityHeaders);
  app.use(app.get(RateLimitService).middleware());
  app.useBodyParser('json', { limit: '1mb' });
  app.disable('x-powered-by');
  if (config.CHRONOS_TRUST_PROXY) app.set('trust proxy', true);
  if (config.CHRONOS_CORS_ORIGINS.length > 0) {
    app.enableCors({ origin: config.CHRONOS_CORS_ORIGINS, credentials: false, exposedHeaders: ['X-Request-Id', 'Retry-After', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'] });
  }

  if (config.CHRONOS_DASHBOARD_ENABLED) mountDashboard(app);

  app.setGlobalPrefix(API_PREFIX, {
    exclude: [
      { path: 'health/live', method: RequestMethod.GET },
      { path: 'health/ready', method: RequestMethod.GET },
    ],
  });
  app.enableShutdownHooks();
  return app;
}
