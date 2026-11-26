import { Injectable, Logger } from '@nestjs/common';
import { Prisma, isUniqueViolation } from '@chronos/database';
import { DEFAULT_QUEUE } from '@chronos/protocol';
import { resolveQueueId } from '@chronos/engine';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { DispatchWakeSignal } from '../../infrastructure/engine/agent-work-signal';
import { AppException } from '../../common/http/app-exception';
import type { Principal } from '../../common/http/request-context';
import { AuditService } from '../audit/audit.service';
import type { RequestMeta } from '../auth/auth.service';
import type { CreateQueueInput, UpdateQueueInput } from './queues.schemas';

const queueSelect = {
  id: true,
  name: true,
  description: true,
  concurrencyLimit: true,
  defaultPriority: true,
  paused: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.QueueSelect;

interface QueueCounts {
  queue_id: string;
  waiting: number;
  delayed: number;
  retrying: number;
  queued: number;
  running: number;
  jobs: number;
}

@Injectable()
export class QueuesService {
  private readonly logger = new Logger(QueuesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly wake: DispatchWakeSignal,
  ) {}

  /**
   * Queues with live counts:
   * - waiting: due now, not yet admitted (paused queue or at a concurrency limit)
   * - delayed: submitted with a future run time
   * - retrying: waiting for a retry backoff
   * - queued: admitted, waiting for an executor
   * - running
   */
  async list(projectId: string) {
    await resolveQueueId(this.prisma, projectId, DEFAULT_QUEUE); // projects always have "default"
    const [queues, counts] = await Promise.all([
      this.prisma.queue.findMany({ where: { projectId }, select: queueSelect, orderBy: { name: 'asc' } }),
      this.counts(projectId),
    ]);
    const byQueue = new Map(counts.map((row) => [row.queue_id, row]));
    return queues.map((queue) => this.withCounts(queue, byQueue.get(queue.id)));
  }

  async get(projectId: string, name: string) {
    const queue = await this.find(projectId, name);
    const [counts] = await this.counts(projectId, queue.id);
    return this.withCounts(queue, counts);
  }

  private withCounts(queue: Prisma.QueueGetPayload<{ select: typeof queueSelect }>, counts: QueueCounts | undefined) {
    return {
      ...queue,
      counts: {
        waiting: counts?.waiting ?? 0,
        delayed: counts?.delayed ?? 0,
        retrying: counts?.retrying ?? 0,
        queued: counts?.queued ?? 0,
        running: counts?.running ?? 0,
      },
      jobs: counts?.jobs ?? 0,
    };
  }

  private counts(projectId: string, queueId?: string): Promise<QueueCounts[]> {
    return this.prisma.$queryRaw<QueueCounts[]>`
      SELECT q.id AS queue_id,
             count(e.id) FILTER (WHERE e.status = 'PENDING' AND e.next_attempt_at <= now())::int AS waiting,
             count(e.id) FILTER (WHERE e.status = 'PENDING' AND e.next_attempt_at > now())::int AS delayed,
             count(e.id) FILTER (WHERE e.status = 'RETRY_SCHEDULED')::int AS retrying,
             count(e.id) FILTER (WHERE e.status = 'QUEUED')::int AS queued,
             count(e.id) FILTER (WHERE e.status = 'RUNNING')::int AS running,
             (SELECT count(*) FROM jobs j WHERE j.queue_id = q.id)::int AS jobs
      FROM queues q
      LEFT JOIN job_executions e ON e.queue_id = q.id AND e.status IN ('PENDING', 'RETRY_SCHEDULED', 'QUEUED', 'RUNNING')
      WHERE q.project_id = ${projectId}::uuid ${queueId ? Prisma.sql`AND q.id = ${queueId}::uuid` : Prisma.empty}
      GROUP BY q.id`;
  }

  private async find(projectId: string, name: string) {
    if (name === DEFAULT_QUEUE) await resolveQueueId(this.prisma, projectId, DEFAULT_QUEUE);
    const queue = await this.prisma.queue.findUnique({ where: { projectId_name: { projectId, name } }, select: queueSelect });
    if (!queue) throw AppException.notFound(`Queue "${name}"`);
    return queue;
  }

  async create(projectId: string, organizationId: string, input: CreateQueueInput, principal: Principal, meta: RequestMeta) {
    try {
      const queue = await this.prisma.queue.create({
        data: {
          projectId,
          name: input.name,
          description: input.description ?? null,
          concurrencyLimit: input.concurrencyLimit ?? null,
          defaultPriority: input.defaultPriority,
        },
        select: queueSelect,
      });
      await this.audit.record({ action: 'queue.created', principal, organizationId, projectId, targetType: 'queue', targetId: queue.id, metadata: { name: queue.name }, requestId: meta.requestId });
      return this.withCounts(queue, undefined);
    } catch (error) {
      if (isUniqueViolation(error)) throw AppException.conflict(`Queue "${input.name}" already exists`);
      throw error;
    }
  }

  async update(projectId: string, organizationId: string, name: string, input: UpdateQueueInput, principal: Principal, meta: RequestMeta) {
    const current = await this.find(projectId, name);
    const queue = await this.prisma.queue.update({ where: { id: current.id }, data: input, select: queueSelect });
    await this.audit.record({ action: 'queue.updated', principal, organizationId, projectId, targetType: 'queue', targetId: queue.id, metadata: { name, fields: Object.keys(input) }, requestId: meta.requestId });
    // A raised (or removed) limit may admit waiting work right away.
    this.wakeDispatcher();
    return this.get(projectId, name);
  }

  async setPaused(projectId: string, organizationId: string, name: string, paused: boolean, principal: Principal, meta: RequestMeta) {
    const current = await this.find(projectId, name);
    await this.prisma.queue.update({ where: { id: current.id }, data: { paused } });
    await this.audit.record({ action: paused ? 'queue.paused' : 'queue.resumed', principal, organizationId, projectId, targetType: 'queue', targetId: current.id, metadata: { name }, requestId: meta.requestId });
    if (!paused) this.wakeDispatcher();
    return this.get(projectId, name);
  }

  /** Only empty queues can be deleted: no jobs assigned and no unfinished executions. */
  async delete(projectId: string, organizationId: string, name: string, principal: Principal, meta: RequestMeta): Promise<void> {
    if (name === DEFAULT_QUEUE) throw AppException.conflict('The default queue cannot be deleted');
    const current = await this.find(projectId, name);
    await this.prisma.$transaction(async (tx) => {
      // Lock the queue so no job can be moved into it while we check.
      await tx.$queryRaw`SELECT id FROM queues WHERE id = ${current.id}::uuid FOR UPDATE`;
      const jobs = await tx.job.count({ where: { queueId: current.id } });
      if (jobs > 0) throw AppException.conflict(`Queue "${name}" still has ${jobs} job(s); move them to another queue first`);
      const active = await tx.jobExecution.count({ where: { queueId: current.id, status: { in: ['PENDING', 'RETRY_SCHEDULED', 'QUEUED', 'RUNNING'] } } });
      if (active > 0) throw AppException.conflict(`Queue "${name}" still has ${active} unfinished execution(s)`);
      await tx.queue.delete({ where: { id: current.id } });
      await this.audit.record({ action: 'queue.deleted', principal, organizationId, projectId, targetType: 'queue', targetId: current.id, metadata: { name }, requestId: meta.requestId }, tx);
    });
  }

  wakeDispatcher(): void {
    this.wake.publish().catch((error: unknown) => this.logger.warn(`Dispatch wake-up failed (next tick will dispatch): ${String(error)}`));
  }
}
