import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { DynamicModule, Module, RequestMethod } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { ConfigModule } from './config/config.module';
import { ServerEnv } from './config/env.schema';
import { HttpExceptionFilter } from './common/http/http-exception.filter';
import { ResponseEnvelopeInterceptor } from './common/http/response-envelope.interceptor';
import { PrismaModule } from './infrastructure/prisma/prisma.module';
import { RedisModule } from './infrastructure/redis/redis.module';
import { EngineModule } from './infrastructure/engine/engine.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { BootstrapModule } from './modules/bootstrap/bootstrap.module';
import { HealthModule } from './modules/health/health.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { ExecutionsModule } from './modules/executions/executions.module';
import { AgentsModule } from './modules/agents/agents.module';
import { EventsModule } from './modules/events/events.module';
import { QueuesModule } from './modules/queues/queues.module';

function loggerModule(config: ServerEnv): DynamicModule {
  return LoggerModule.forRoot({
    forRoutes: [{ path: '{*path}', method: RequestMethod.ALL }],
    pinoHttp: {
      level: config.LOG_LEVEL,
      // The id is assigned by requestIdMiddleware (registered first in app.factory).
      genReqId: (request: IncomingMessage) => (request as IncomingMessage & { id?: string }).id ?? randomUUID(),
      customProps: (request: IncomingMessage) => ({ requestId: (request as IncomingMessage & { id: string }).id }),
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]'],
        censor: '[redacted]',
      },
      autoLogging: { ignore: (request: IncomingMessage) => request.url?.startsWith('/health/') ?? false },
      ...(config.LOG_PRETTY ? { transport: { target: 'pino-pretty', options: { singleLine: true } } } : {}),
    },
  });
}

@Module({})
export class AppModule {
  static forRoot(config: ServerEnv): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        loggerModule(config),
        PrismaModule,
        RedisModule,
        EngineModule,
        AuditModule,
        AuthModule,
        BootstrapModule,
        OrganizationsModule,
        ProjectsModule,
        JobsModule,
        ExecutionsModule,
        AgentsModule,
        EventsModule,
        QueuesModule,
        HealthModule,
      ],
      providers: [
        { provide: APP_FILTER, useClass: HttpExceptionFilter },
        { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
      ],
    };
  }
}
