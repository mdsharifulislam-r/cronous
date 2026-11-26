import { Controller, Delete, Get, HttpCode, HttpStatus, Param, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { leaseOwnerOf } from '@chronos/engine';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { ZodValidationPipe, uuidParam } from '../../common/http/zod-validation.pipe';
import { AppException } from '../../common/http/app-exception';
import type { AccessScope, ChronosRequest, Principal } from '../../common/http/request-context';
import { AuditService } from '../audit/audit.service';
import { AllowPrincipals, CurrentPrincipal, CurrentScope, RequireRole } from '../auth/auth.decorators';

const listAgentsQuery = z.object({ status: z.enum(['ONLINE', 'DRAINING', 'OFFLINE']).optional() }).strict();

const agentView = {
  id: true,
  /** The credential the agent authenticated with (id only; revoking it disconnects the agent). */
  credentialId: true,
  instanceId: true,
  hostname: true,
  sdkVersion: true,
  protocolVersion: true,
  status: true,
  handlers: true,
  connectedAt: true,
  lastHeartbeatAt: true,
  disconnectedAt: true,
} as const;

@Controller()
export class AgentsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get('projects/:projectId/agents')
  @AllowPrincipals('user', 'project')
  @RequireRole('VIEWER')
  listAgents(
    @Param('projectId', uuidParam) projectId: string,
    @Query(new ZodValidationPipe(listAgentsQuery)) query: { status?: 'ONLINE' | 'DRAINING' | 'OFFLINE' },
  ) {
    return this.prisma.agent.findMany({
      where: { projectId, ...(query.status ? { status: query.status } : {}) },
      select: agentView,
      orderBy: [{ status: 'asc' }, { lastHeartbeatAt: 'desc' }],
      take: 500,
    });
  }

  @Get('projects/:projectId/agents/:agentId')
  @AllowPrincipals('user', 'project')
  @RequireRole('VIEWER')
  async getAgent(@Param('projectId', uuidParam) projectId: string, @Param('agentId', uuidParam) agentId: string) {
    const agent = await this.prisma.agent.findFirst({ where: { id: agentId, projectId }, select: { ...agentView, metadata: true } });
    if (!agent) throw AppException.notFound('Agent');
    const running = await this.prisma.jobExecution.count({ where: { projectId, status: 'RUNNING', leaseOwner: leaseOwnerOf({ kind: 'agent', agentId }) } });
    return { ...agent, runningExecutions: running };
  }

  /**
   * Removes the record of an agent that is no longer connected. Attempt history keeps
   * its rows (the agent reference becomes null). Connected agents cannot be removed:
   * revoke their credential instead, which disconnects them.
   */
  @Delete('projects/:projectId/agents/:agentId')
  @RequireRole('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeAgent(
    @Param('projectId', uuidParam) projectId: string,
    @Param('agentId', uuidParam) agentId: string,
    @CurrentScope() scope: AccessScope,
    @CurrentPrincipal() principal: Principal,
    @Req() request: ChronosRequest,
  ): Promise<void> {
    const removed = await this.prisma.agent.deleteMany({ where: { id: agentId, projectId, status: 'OFFLINE' } });
    if (removed.count === 0) {
      const exists = await this.prisma.agent.findFirst({ where: { id: agentId, projectId }, select: { status: true } });
      if (!exists) throw AppException.notFound('Agent');
      throw AppException.conflict(`Agent is ${exists.status}; only OFFLINE agents can be removed`);
    }
    await this.audit.record({ action: 'agent.removed', principal, organizationId: scope.organizationId, projectId, targetType: 'agent', targetId: agentId, requestId: request.id });
  }

  /**
   * The project an agent token belongs to. Lets the SDK address project-scoped REST
   * routes (job submission) knowing only its token, and detect a misconfigured slug.
   */
  @Get('agent/identity')
  @AllowPrincipals('agent')
  async identity(@CurrentPrincipal() principal: Principal) {
    if (principal.type !== 'agent') throw AppException.forbidden();
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: principal.projectId }, select: { id: true, slug: true, timezone: true } });
    return { projectId: project.id, projectSlug: project.slug, timezone: project.timezone, credentialId: principal.credentialId };
  }

  /** Central workers are installation-wide infrastructure; any signed-in user may view them. */
  @Get('workers')
  async listWorkers() {
    const workers = await this.prisma.worker.findMany({ orderBy: [{ status: 'asc' }, { lastHeartbeatAt: 'desc' }], take: 500 });
    const running = await this.prisma.jobExecution.groupBy({
      by: ['leaseOwner'],
      where: { status: 'RUNNING', leaseOwner: { in: workers.map((worker) => leaseOwnerOf({ kind: 'worker', workerId: worker.id })) } },
      _count: { _all: true },
    });
    const byOwner = new Map(running.map((row) => [row.leaseOwner, row._count._all]));
    return workers.map((worker) => ({ ...worker, runningExecutions: byOwner.get(leaseOwnerOf({ kind: 'worker', workerId: worker.id })) ?? 0 }));
  }

  /**
   * One worker with its load and recent attempts. Counts cover all projects (workers are
   * shared infrastructure); the attempt list only includes projects of organizations the
   * caller is a member of, so no other tenant's job names leak.
   */
  @Get('workers/:workerId')
  async getWorker(@Param('workerId', uuidParam) workerId: string, @CurrentPrincipal() principal: Principal) {
    if (principal.type !== 'user') throw AppException.forbidden();
    const worker = await this.prisma.worker.findUnique({ where: { id: workerId } });
    if (!worker) throw AppException.notFound('Worker');
    const since = new Date(Date.now() - 24 * 3600_000);
    const [running, attempts, recent] = await Promise.all([
      this.prisma.jobExecution.count({ where: { status: 'RUNNING', leaseOwner: leaseOwnerOf({ kind: 'worker', workerId }) } }),
      this.prisma.jobAttempt.groupBy({ by: ['status'], where: { workerId, startedAt: { gte: since } }, _count: { _all: true } }),
      this.prisma.jobAttempt.findMany({
        where: { workerId, execution: { project: { organization: { memberships: { some: { userId: principal.userId } } } } } },
        orderBy: { startedAt: 'desc' },
        take: 50,
        select: {
          executionId: true,
          attemptNumber: true,
          status: true,
          startedAt: true,
          finishedAt: true,
          errorCode: true,
          execution: { select: { projectId: true, mode: true, job: { select: { name: true } } } },
        },
      }),
    ]);
    const count = (status: string) => attempts.find((row) => row.status === status)?._count._all ?? 0;
    return {
      ...worker,
      runningExecutions: running,
      attempts24h: { succeeded: count('SUCCEEDED'), failed: count('FAILED'), timedOut: count('TIMED_OUT'), abandoned: count('ABANDONED') },
      modes: [...new Set(recent.map((attempt) => attempt.execution.mode))],
      recentAttempts: recent.map(({ execution, ...attempt }) => ({ ...attempt, projectId: execution.projectId, jobName: execution.job.name })),
    };
  }
}
