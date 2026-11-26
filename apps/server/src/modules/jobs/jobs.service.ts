import { Injectable } from '@nestjs/common';
import { Prisma, isUniqueViolation } from '@chronos/database';
import {
  ExecutionStore,
  HttpConfig,
  applySchedule,
  dbNow,
  maskHttpConfig,
  pauseSchedule,
  resumeSchedule,
  resolveQueueId,
  restoreMaskedSecrets,
  scheduleSpecFrom,
} from '@chronos/engine';
import { upcomingCronOccurrences } from '@chronos/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AppException } from '../../common/http/app-exception';
import type { Principal } from '../../common/http/request-context';
import { AuditService } from '../audit/audit.service';
import { QueuesService } from '../queues/queues.service';
import { SubmissionsService } from '../queues/submissions.service';
import type { RequestMeta } from '../auth/auth.service';
import type { CreateJobInput, ListJobsQuery, TriggerJobInput, UpdateJobInput } from './jobs.schemas';

const jobInclude = { schedule: true, queue: { select: { name: true } } } satisfies Prisma.JobInclude;
type JobRow = Prisma.JobGetPayload<{ include: typeof jobInclude }>;

export function toJobView(job: JobRow) {
  const { httpConfig, schedule, queue, ...rest } = job;
  return {
    ...rest,
    queue: queue.name,
    http: httpConfig === null ? null : maskHttpConfig(httpConfig),
    schedule: schedule
      ? {
          type: schedule.type,
          cron: schedule.cronExpression,
          runAt: schedule.runAt,
          timezone: schedule.timezone,
          state: schedule.state,
          misfirePolicy: schedule.misfirePolicy,
          misfireGraceMs: schedule.misfireGraceMs,
          maxCatchUp: schedule.maxCatchUp,
          nextRunAt: schedule.nextRunAt,
          lastScheduledAt: schedule.lastScheduledAt,
          version: schedule.version,
        }
      : null,
  };
}

/** Resolves masked secrets ("********") against the stored config; rejects masks with nothing to restore. */
function resolveHttpConfig(next: HttpConfig, stored: unknown): HttpConfig {
  const restored = restoreMaskedSecrets(next, stored);
  if ('error' in restored) throw AppException.badRequest(restored.error);
  return restored.config;
}

/** Fields an SDK-managed job may change through the API (operator controls only). */
const SDK_MUTABLE_FIELDS = new Set(['enabled']);

@Injectable()
export class JobsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly executions: ExecutionStore,
    private readonly audit: AuditService,
    private readonly queues: QueuesService,
    private readonly submissions: SubmissionsService,
  ) {}

  /** Resolves a queue name to its id inside the transaction (before any job row is locked). */
  private async queueIdOf(tx: Prisma.TransactionClient, projectId: string, name: string): Promise<string> {
    const id = await resolveQueueId(tx, projectId, name);
    if (!id) throw AppException.badRequest(`Queue "${name}" does not exist; create it first`, { field: 'queue' });
    return id;
  }

  /** Rejects schemas that do not compile and static payloads that do not satisfy them. */
  private checkPayloadSchema(schema: unknown, payload: unknown): void {
    if (schema === null || schema === undefined) return;
    const problem = this.executions.payloadValidator.checkSchema(schema);
    if (problem) throw AppException.badRequest(problem, { field: 'payloadSchema' });
    if (payload === undefined || payload === null) return;
    const issues = this.executions.payloadValidator.validate(schema as Record<string, unknown>, payload);
    if (issues.length > 0) {
      throw AppException.badRequest('The job\'s default payload does not match its payloadSchema', issues);
    }
  }

  private async projectTimeZone(tx: Prisma.TransactionClient, projectId: string): Promise<string> {
    const project = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { timezone: true } });
    return project.timezone;
  }

  async create(projectId: string, organizationId: string, input: CreateJobInput, principal: Principal, meta: RequestMeta) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const now = await dbNow(tx);
        const queueId = await this.queueIdOf(tx, projectId, input.queue);
        this.checkPayloadSchema(input.payloadSchema, input.payload);
        const job = await tx.job.create({
          data: {
            projectId,
            queueId,
            priority: input.priority ?? null,
            maxConcurrency: input.maxConcurrency ?? null,
            payloadSchema: input.payloadSchema ? (input.payloadSchema as Prisma.InputJsonValue) : Prisma.JsonNull,
            name: input.name,
            description: input.description ?? null,
            mode: input.mode,
            source: 'API',
            enabled: input.enabled,
            httpConfig: input.http ? resolveHttpConfig(input.http, null) : Prisma.JsonNull,
            payload: input.payload === undefined ? Prisma.JsonNull : (input.payload as Prisma.InputJsonValue),
            timeoutMs: input.timeoutMs,
            maxAttempts: input.maxAttempts,
            retryBackoffMs: input.retryBackoffMs,
            retryBackoffMaxMs: input.retryBackoffMaxMs,
            concurrencyPolicy: input.concurrencyPolicy,
          },
        });
        if (input.schedule) {
          await applySchedule(tx, job.id, scheduleSpecFrom(input.schedule, await this.projectTimeZone(tx, projectId)), now);
        }
        await this.audit.record(
          { action: 'job.created', principal, organizationId, projectId, targetType: 'job', targetId: job.id, metadata: { name: job.name, mode: job.mode }, requestId: meta.requestId },
          tx,
        );
        return toJobView(await tx.job.findUniqueOrThrow({ where: { id: job.id }, include: jobInclude }));
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw AppException.conflict(`A job named "${input.name}" already exists in this project`);
      throw error;
    }
  }

  async list(projectId: string, filter: ListJobsQuery) {
    const jobs = await this.prisma.job.findMany({
      where: {
        projectId,
        ...(filter.queue ? { queue: { name: filter.queue } } : {}),
        ...(filter.mode ? { mode: filter.mode } : {}),
        ...(filter.enabled !== undefined ? { enabled: filter.enabled } : {}),
        ...(filter.source ? { source: filter.source } : {}),
        ...(filter.q
          ? { OR: [{ name: { contains: filter.q, mode: 'insensitive' } }, { description: { contains: filter.q, mode: 'insensitive' } }] }
          : {}),
      },
      include: jobInclude,
      orderBy: { name: 'asc' },
    });
    const last = jobs.length
      ? await this.prisma.$queryRaw<{ job_id: string; id: string; status: string; trigger: string; created_at: Date; finished_at: Date | null }[]>`
          SELECT DISTINCT ON (job_id) job_id, id, status, trigger, created_at, finished_at
          FROM job_executions WHERE job_id = ANY(${jobs.map((job) => job.id)}::uuid[])
          ORDER BY job_id, created_at DESC`
      : [];
    const byJob = new Map(last.map((row) => [row.job_id, { id: row.id, status: row.status, trigger: row.trigger, createdAt: row.created_at, finishedAt: row.finished_at }]));
    return jobs.map((job) => ({ ...toJobView(job), lastExecution: byJob.get(job.id) ?? null }));
  }

  async get(projectId: string, jobId: string) {
    return toJobView(await this.find(this.prisma, projectId, jobId));
  }

  private async find(db: Prisma.TransactionClient | PrismaService, projectId: string, jobId: string): Promise<JobRow> {
    const job = await db.job.findFirst({ where: { id: jobId, projectId }, include: jobInclude });
    if (!job) throw AppException.notFound('Job');
    return job;
  }

  async update(projectId: string, organizationId: string, jobId: string, input: UpdateJobInput, principal: Principal, meta: RequestMeta) {
    return this.prisma.$transaction(async (tx) => {
      const current = await this.find(tx, projectId, jobId);
      if (current.source === 'SDK') {
        const forbidden = Object.keys(input).filter((field) => !SDK_MUTABLE_FIELDS.has(field));
        if (forbidden.length > 0) {
          throw AppException.conflict(`Job "${current.name}" is defined in application code via the SDK; change it there`, { fields: forbidden });
        }
      }

      const mode = input.mode ?? current.mode;
      const hasHttp = input.http !== undefined || current.httpConfig !== null;
      if (mode === 'HTTP' && !hasHttp) throw AppException.badRequest('"http" is required for HTTP jobs');
      const backoff = input.retryBackoffMs ?? current.retryBackoffMs;
      const backoffMax = input.retryBackoffMaxMs ?? current.retryBackoffMaxMs;
      if (backoffMax < backoff) throw AppException.badRequest('retryBackoffMaxMs must be >= retryBackoffMs');
      if (input.payloadSchema !== undefined || input.payload !== undefined) {
        this.checkPayloadSchema(input.payloadSchema !== undefined ? input.payloadSchema : current.payloadSchema, input.payload !== undefined ? input.payload : current.payload);
      }
      // Resolve the queue before updating the job row (same lock order as the dispatcher).
      const queueId = input.queue !== undefined ? await this.queueIdOf(tx, projectId, input.queue) : undefined;

      await tx.job.update({
        where: { id: jobId },
        data: {
          ...(queueId !== undefined ? { queueId } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(input.maxConcurrency !== undefined ? { maxConcurrency: input.maxConcurrency } : {}),
          ...(input.payloadSchema !== undefined
            ? { payloadSchema: input.payloadSchema === null ? Prisma.JsonNull : (input.payloadSchema as Prisma.InputJsonValue) }
            : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.mode !== undefined ? { mode: input.mode } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          // Switching away from HTTP drops the webhook configuration.
          ...(input.http !== undefined ? { httpConfig: resolveHttpConfig(input.http, current.httpConfig) } : mode !== 'HTTP' ? { httpConfig: Prisma.JsonNull } : {}),
          ...(input.payload !== undefined ? { payload: input.payload as Prisma.InputJsonValue } : {}),
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
          ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
          ...(input.retryBackoffMs !== undefined ? { retryBackoffMs: input.retryBackoffMs } : {}),
          ...(input.retryBackoffMaxMs !== undefined ? { retryBackoffMaxMs: input.retryBackoffMaxMs } : {}),
          ...(input.concurrencyPolicy !== undefined ? { concurrencyPolicy: input.concurrencyPolicy } : {}),
        },
      });
      if (input.schedule !== undefined) {
        const spec = input.schedule ? scheduleSpecFrom(input.schedule, await this.projectTimeZone(tx, projectId)) : null;
        await applySchedule(tx, jobId, spec, await dbNow(tx));
      }
      await this.audit.record(
        { action: 'job.updated', principal, organizationId, projectId, targetType: 'job', targetId: jobId, metadata: { fields: Object.keys(input) }, requestId: meta.requestId },
        tx,
      );
      return toJobView(await this.find(tx, projectId, jobId));
    });
  }

  /** Deletes the job and its execution history. SDK jobs reappear when an agent reconnects. */
  async delete(projectId: string, organizationId: string, jobId: string, principal: Principal, meta: RequestMeta): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const job = await this.find(tx, projectId, jobId);
      await tx.job.delete({ where: { id: jobId } });
      await this.audit.record(
        { action: 'job.deleted', principal, organizationId, projectId, targetType: 'job', targetId: jobId, metadata: { name: job.name }, requestId: meta.requestId },
        tx,
      );
    });
  }

  async setPaused(projectId: string, organizationId: string, jobId: string, paused: boolean, principal: Principal, meta: RequestMeta) {
    return this.prisma.$transaction(async (tx) => {
      const job = await this.find(tx, projectId, jobId);
      if (!job.schedule) throw AppException.badRequest('Job has no schedule');
      if (job.schedule.state === 'COMPLETED') throw AppException.conflict('One-time schedule already completed; set a new runAt instead');
      if (paused) await pauseSchedule(tx, jobId);
      else await resumeSchedule(tx, jobId, await dbNow(tx));
      await this.audit.record(
        { action: paused ? 'job.paused' : 'job.resumed', principal, organizationId, projectId, targetType: 'job', targetId: jobId, requestId: meta.requestId },
        tx,
      );
      return toJobView(await this.find(tx, projectId, jobId));
    });
  }

  async trigger(projectId: string, organizationId: string, jobId: string, input: TriggerJobInput, principal: Principal, meta: RequestMeta) {
    const result = await this.executions.trigger({
      jobId,
      projectId,
      ...(input.payload !== undefined ? { payload: input.payload as Prisma.InputJsonValue } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });
    const execution = this.submissions.unwrap(result, jobId);
    if (result.outcome === 'duplicate') return { execution, created: false };
    this.queues.wakeDispatcher();
    await this.audit.record({
      action: 'job.triggered',
      principal,
      organizationId,
      projectId,
      targetType: 'execution',
      targetId: execution.id,
      requestId: meta.requestId,
    });
    return { execution, created: true };
  }

  async preview(projectId: string, jobId: string, count: number) {
    const job = await this.find(this.prisma, projectId, jobId);
    const schedule = job.schedule;
    if (!schedule) return { occurrences: [] };
    if (schedule.type === 'ONCE') return { occurrences: schedule.state === 'COMPLETED' ? [] : [schedule.runAt] };
    return {
      timezone: schedule.timezone,
      occurrences: upcomingCronOccurrences(schedule.cronExpression!, schedule.timezone, new Date(), count),
    };
  }
}
