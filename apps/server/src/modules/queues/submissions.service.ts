import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@chronos/database';
import { ExecutionRow, ExecutionStore, SubmitResult } from '@chronos/engine';
import type { QueueSubmission } from '@chronos/protocol';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AppException } from '../../common/http/app-exception';
import type { Principal } from '../../common/http/request-context';
import { AuditService } from '../audit/audit.service';
import type { RequestMeta } from '../auth/auth.service';
import { QueuesService } from './queues.service';

/** Manual and queue idempotency keys are stored with this prefix (shared namespace per job). */
const KEY_PREFIX = 'manual:';

export interface SubmittedExecution {
  id: string;
  jobId: string;
  jobName: string;
  queue: string | null;
  status: string;
  trigger: string;
  priority: number;
  delayed: boolean;
  scheduledFor: Date;
  nextAttemptAt: Date | null;
  idempotencyKey: string | null;
  maxAttempts: number;
  timeoutMs: number;
  createdAt: Date;
}

export interface BatchItemResult {
  index: number;
  outcome: 'created' | 'duplicate' | 'error';
  execution?: SubmittedExecution;
  error?: { status: number; code: string; message: string; details?: unknown };
}

@Injectable()
export class SubmissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: ExecutionStore,
    private readonly queues: QueuesService,
    private readonly audit: AuditService,
  ) {}

  /** Submits one job execution. 201-style `created: true`, or the original on idempotent replay. */
  async submit(projectId: string, organizationId: string, input: QueueSubmission, principal: Principal, meta: RequestMeta) {
    const result = await this.store.submit({
      projectId,
      job: { name: input.job },
      trigger: 'QUEUE',
      ...(input.payload !== undefined ? { payload: input.payload as Prisma.InputJsonValue } : {}),
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.delayMs !== undefined ? { delayMs: input.delayMs } : {}),
      ...(input.runAt !== undefined ? { runAt: input.runAt } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.queue !== undefined ? { queue: input.queue } : {}),
      ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
      ...(input.retryBackoffMs !== undefined ? { retryBackoffMs: input.retryBackoffMs } : {}),
      ...(input.retryBackoffMaxMs !== undefined ? { retryBackoffMaxMs: input.retryBackoffMaxMs } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    });
    const created = this.unwrap(result, input.job);
    if (result.outcome === 'created') {
      if (!result.delayed) this.queues.wakeDispatcher();
      await this.audit.record({
        action: 'job.queued',
        principal,
        organizationId,
        projectId,
        targetType: 'execution',
        targetId: created.id,
        metadata: { job: input.job, delayed: result.delayed },
        requestId: meta.requestId,
      });
    }
    const view = await this.view(created);
    // For a new submission the engine decided "delayed" with the database clock; trust that.
    if (result.outcome === 'created') view.delayed = result.delayed;
    return { execution: view, created: result.outcome === 'created' };
  }

  /** Each item is submitted independently (its own transaction); one failure does not affect the others. */
  async submitBatch(projectId: string, organizationId: string, items: QueueSubmission[], principal: Principal, meta: RequestMeta) {
    const results: BatchItemResult[] = [];
    for (const [index, item] of items.entries()) {
      try {
        const { execution, created } = await this.submit(projectId, organizationId, item, principal, meta);
        results.push({ index, outcome: created ? 'created' : 'duplicate', execution });
      } catch (error) {
        if (!(error instanceof AppException)) throw error;
        results.push({ index, outcome: 'error', error: { status: error.getStatus(), code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) } });
      }
    }
    return {
      results,
      summary: {
        created: results.filter((result) => result.outcome === 'created').length,
        duplicate: results.filter((result) => result.outcome === 'duplicate').length,
        failed: results.filter((result) => result.outcome === 'error').length,
      },
    };
  }

  /** Maps engine outcomes to API errors; returns the execution for created/duplicate. */
  unwrap(result: SubmitResult, jobLabel: string): ExecutionRow {
    switch (result.outcome) {
      case 'created':
      case 'duplicate':
        return result.execution;
      case 'not_found':
        throw AppException.notFound(`Job "${jobLabel}"`);
      case 'queue_not_found':
        throw AppException.notFound(`Queue "${result.queue}"`);
      case 'disabled':
        throw AppException.conflict('Job is disabled');
      case 'overlap':
        throw AppException.conflict('Job forbids overlapping executions and one is still active', { activeExecutionId: result.activeExecutionId });
      case 'invalid_payload':
        throw new AppException(
          HttpStatus.BAD_REQUEST,
          'VALIDATION_FAILED',
          'Payload does not match the job\'s payload schema',
          result.issues.map((issue) => ({ path: `payload${issue.path.replace(/\//g, '.')}`, message: issue.message })),
        );
      case 'invalid_settings':
        throw AppException.badRequest(result.message);
    }
  }

  async view(execution: ExecutionRow): Promise<SubmittedExecution> {
    const [job, queue] = await Promise.all([
      this.prisma.job.findUnique({ where: { id: execution.jobId }, select: { name: true } }),
      execution.queueId ? this.prisma.queue.findUnique({ where: { id: execution.queueId }, select: { name: true } }) : null,
    ]);
    return {
      id: execution.id,
      jobId: execution.jobId,
      jobName: job?.name ?? '',
      queue: queue?.name ?? null,
      status: execution.status,
      trigger: execution.trigger,
      priority: execution.priority,
      delayed: isDelayed(execution),
      scheduledFor: execution.scheduledFor,
      nextAttemptAt: execution.nextAttemptAt,
      idempotencyKey: publicIdempotencyKey(execution.idempotencyKey),
      maxAttempts: execution.maxAttempts,
      timeoutMs: execution.timeoutMs,
      createdAt: execution.createdAt,
    };
  }
}

/** Waiting for a future run time (submitted with a delay), judged with the server clock. */
/**
 * Slack for comparing database timestamps with this process's clock. Without it, an
 * immediate submission looks "delayed" whenever PostgreSQL's clock is a few ms ahead.
 * 500 ms covers normal NTP skew while keeping sub-second-plus delays visible.
 */
export const DELAY_TOLERANCE_MS = 500;

export function isDelayed(execution: { status: string; nextAttemptAt: Date | null }, now = Date.now()): boolean {
  return execution.status === 'PENDING' && execution.nextAttemptAt !== null && execution.nextAttemptAt.getTime() > now + DELAY_TOLERANCE_MS;
}

/** The key as the client sent it; generated keys and schedule keys are reported as-is. */
export function publicIdempotencyKey(stored: string): string {
  return stored.startsWith(KEY_PREFIX) ? stored.slice(KEY_PREFIX.length) : stored;
}
