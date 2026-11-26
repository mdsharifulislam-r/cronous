import { Controller, Get, HttpStatus, Inject, Param, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { APP_CONFIG } from '../../config/config.module';
import { ServerEnv } from '../../config/env.schema';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AppException } from '../../common/http/app-exception';
import { uuidParam } from '../../common/http/zod-validation.pipe';
import type { ChronosRequest, Principal } from '../../common/http/request-context';
import { AllowPrincipals, CurrentPrincipal, RequireRole } from '../auth/auth.decorators';
import { CredentialsService } from '../auth/credentials.service';
import { DashboardEvent, DashboardEventsService } from './dashboard-events.service';

const KEEPALIVE_MS = 15_000;

/**
 * Real-time dashboard updates as Server-Sent Events (text/event-stream).
 *
 * Authentication is the normal `Authorization: Bearer` header, so browsers consume the
 * stream with fetch() (EventSource cannot send headers). Events are change
 * notifications: clients load state through the REST API and apply events on top of it,
 * and reload after reconnecting (there is no replay of missed events).
 */
@Controller('projects/:projectId/events')
@AllowPrincipals('user', 'project')
export class EventsController {
  constructor(
    private readonly events: DashboardEventsService,
    private readonly credentials: CredentialsService,
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: ServerEnv,
  ) {}

  @Get()
  @RequireRole('VIEWER')
  stream(
    @Param('projectId', uuidParam) projectId: string,
    @CurrentPrincipal() principal: Principal,
    @Req() request: ChronosRequest,
    @Res() response: Response,
  ): void {
    if (!this.events.canAccept) {
      throw new AppException(HttpStatus.SERVICE_UNAVAILABLE, 'SERVICE_UNAVAILABLE', 'Too many open event streams; retry later', {
        retryAfterSeconds: 5,
      });
    }

    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-store, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no'); // nginx: do not buffer the stream
    response.flushHeaders();
    request.socket.setKeepAlive(true);
    request.socket.setTimeout(0);

    let sequence = 0;
    let closed = false;
    const write = (chunk: string) => {
      if (!closed && !response.writableEnded) response.write(chunk);
    };
    const send = (event: DashboardEvent) => write(`id: ${++sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);

    const timers: NodeJS.Timeout[] = [];
    let unsubscribe = () => {};
    const cleanup = () => {
      closed = true;
      for (const timer of timers) clearInterval(timer);
      unsubscribe();
    };
    const close = (reason: string) => {
      if (closed) return;
      write(`event: close\ndata: ${JSON.stringify({ reason })}\n\n`);
      cleanup();
      response.end();
    };

    write(`retry: 3000\n\n`);
    write(`event: ready\ndata: ${JSON.stringify({ projectId, serverTime: new Date(), pollIntervalMs: this.config.CHRONOS_EVENTS_POLL_MS })}\n\n`);

    unsubscribe = this.events.subscribe({ projectId, includeWorkers: principal.type === 'user', send, close });
    timers.push(setInterval(() => write(': keepalive\n\n'), KEEPALIVE_MS));
    timers.push(
      setInterval(() => {
        void this.stillAuthorized(principal, projectId)
          .then((ok) => {
            if (!ok) close('unauthorized');
          })
          .catch(() => undefined);
      }, this.config.CHRONOS_CREDENTIAL_RECHECK_MS),
    );
    request.on('close', cleanup);
  }

  /** The stream authenticated once; revocation, logout, removal from the org or archiving end it. */
  private async stillAuthorized(principal: Principal, projectId: string): Promise<boolean> {
    if (!(await this.credentials.isActive(principal.credentialId))) return false;
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { organizationId: true, archivedAt: true } });
    if (!project || project.archivedAt) return false;
    if (principal.type !== 'user') return principal.projectId === projectId;
    const membership = await this.prisma.membership.findUnique({
      where: { organizationId_userId: { organizationId: project.organizationId, userId: principal.userId } },
      select: { id: true },
    });
    return membership !== null;
  }
}
