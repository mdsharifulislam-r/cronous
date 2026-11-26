import { randomUUID } from 'node:crypto';
import { AttemptStatus, ExecutionStatus, Prisma, PrismaClient, isUniqueViolation } from '@chronos/database';
import { retryDelayMs } from '@chronos/shared';
import { dbNow, truncate } from './common';
import { resolveQueueId } from './jobs';
import { PayloadIssue, PayloadSchemaValidator } from './payload-schema';
import { ACTIVE_EXECUTION_STATUSES } from './scheduler';

/**
 * One submission: a manual trigger ("run now") or a queue submission (immediate or
 * delayed). Both create a durable PENDING execution that the dispatcher admits through
 * the job's queue, exactly like scheduled occurrences.
 */
export interface SubmitInput {
  projectId: string;
  /** The job, by id (dashboard trigger) or by name (queue API, SDK). */
  job: { id: string } | { name: string };
  trigger: 'MANUAL' | 'QUEUE';
  payload?: Prisma.InputJsonValue;
  idempotencyKey?: string;
  /** Delay from now (database clock). Mutually exclusive with runAt. */
  delayMs?: number;
  /** Absolute due time; a past value means "now". */
  runAt?: Date;
  priority?: number;
  /** Queue name overriding the job's queue. */
  queue?: string;
  maxAttempts?: number;
  retryBackoffMs?: number;
  retryBackoffMaxMs?: number;
  timeoutMs?: number;
  /**
   * Reject with "overlap" when the job forbids overlap and one is active (manual
   * triggers). Queue submissions instead wait for admission (maxConcurrency / FORBID).
   */
  rejectOverlap?: boolean;
}

export type ExecutionRow = Prisma.JobExecutionGetPayload<object>;

export type SubmitResult =
  | { outcome: 'created'; execution: ExecutionRow; /** due later than now (database clock) */ delayed: boolean }
  | { outcome: 'duplicate'; execution: ExecutionRow }
  | { outcome: 'not_found' }
  | { outcome: 'queue_not_found'; queue: string }
  | { outcome: 'disabled' }
  | { outcome: 'overlap'; activeExecutionId: string }
  | { outcome: 'invalid_payload'; issues: PayloadIssue[] }
  | { outcome: 'invalid_settings'; message: string };

export type Executor = { kind: 'worker'; workerId: string } | { kind: 'agent'; agentId: string };

export function leaseOwnerOf(executor: Executor): string {
  return executor.kind === 'worker' ? `worker:${executor.workerId}` : `agent:${executor.agentId}`;
}

/** Identifies one attempt held by one executor. Every write is fenced on all three. */
export interface AttemptRef {
  executionId: string;
  attempt: number;
  owner: string;
}

export interface ClaimedExecution {
  executionId: string;
  attempt: number;
  jobId: string;
  projectId: string;
  jobName: string;
  mode: 'HTTP' | 'AGENT' | 'WORKER';
  payload: Prisma.JsonValue | null;
  idempotencyKey: string;
  scheduledFor: Date;
  timeoutMs: number;
  httpConfig: Prisma.JsonValue | null;
  leaseExpiresAt: Date;
  owner: string;
}

export interface FailureReport {
  message: string;
  code?: string;
  /** false = permanent failure (e.g. HTTP 400): no retry, status FAILED. */
  retryable: boolean;
  timedOut?: boolean;
  /** The executor gave up on the attempt (disconnect, shutdown) rather than failing it. */
  abandoned?: boolean;
  httpStatus?: number;
  output?: Prisma.InputJsonValue;
}

export interface SuccessReport {
  output?: Prisma.InputJsonValue;
  httpStatus?: number;
}

interface LockedExecution {
  id: string;
  status: ExecutionStatus;
  attempt_count: number;
  max_attempts: number;
  lease_owner: string | null;
  retry_backoff_ms: number;
  retry_backoff_max_ms: number;
}

const MAX_ERROR_LENGTH = 4000;
export const TERMINAL_STATUSES: ExecutionStatus[] = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'DEAD_LETTERED'];

/**
 * The execution state machine. Durable state lives in PostgreSQL. Every transition is a
 * conditional update, so concurrent or late actors (duplicate deliveries, executors
 * that lost their lease, the reaper) cannot corrupt it.
 *
 *   PENDING ─dispatch─▶ QUEUED ─claim─▶ RUNNING ─▶ SUCCEEDED
 *      ▲                                  │  ├──▶ RETRY_SCHEDULED ─dispatch─▶ QUEUED
 *      └──────── replay ◀── DEAD_LETTERED ◀┤  ├──▶ FAILED (non-retryable)
 *                                          └──▶ CANCELLED
 */
export class ExecutionStore {
  constructor(
    private readonly prisma: PrismaClient,
    readonly payloadValidator: PayloadSchemaValidator = new PayloadSchemaValidator(),
  ) {}

  /** Claims a QUEUED execution for an executor. Returns null if anyone else got it first. */
  async claim(executionId: string, executor: Executor, leaseMs: number): Promise<ClaimedExecution | null> {
    const owner = leaseOwnerOf(executor);
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; attempt_count: number; lease_expires_at: Date }[]>`
        UPDATE job_executions
        SET status = 'RUNNING', lease_owner = ${owner},
            lease_expires_at = now() + ${leaseMs} * interval '1 millisecond',
            attempt_count = attempt_count + 1, started_at = COALESCE(started_at, now()), updated_at = now()
        WHERE id = ${executionId}::uuid AND status = 'QUEUED'
        RETURNING id, attempt_count, lease_expires_at`;
      const row = rows[0];
      if (!row) return null;
      await this.createAttempts(tx, [row], executor);
      const [claimed] = await this.loadClaimed(tx, [row], owner);
      return claimed ?? null;
    });
  }

  /**
   * Claims up to `limit` QUEUED agent executions of a project whose task the agent has
   * a handler for. Used by the server replica holding the agent's WebSocket.
   */
  async claimForAgent(projectId: string, agentId: string, taskNames: string[], limit: number, leaseMs: number): Promise<ClaimedExecution[]> {
    if (limit <= 0 || taskNames.length === 0) return [];
    const executor: Executor = { kind: 'agent', agentId };
    const owner = leaseOwnerOf(executor);
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; attempt_count: number; lease_expires_at: Date }[]>`
        UPDATE job_executions
        SET status = 'RUNNING', lease_owner = ${owner},
            lease_expires_at = now() + ${leaseMs} * interval '1 millisecond',
            attempt_count = attempt_count + 1, started_at = COALESCE(started_at, now()), updated_at = now()
        WHERE id IN (
          SELECT e.id FROM job_executions e JOIN jobs j ON j.id = e.job_id
          WHERE e.project_id = ${projectId}::uuid AND e.mode = 'AGENT' AND e.status = 'QUEUED'
            AND j.name = ANY(${taskNames}::text[])
          ORDER BY e.priority DESC, e.scheduled_for
          LIMIT ${limit}
          FOR UPDATE OF e SKIP LOCKED)
        RETURNING id, attempt_count, lease_expires_at`;
      if (rows.length === 0) return [];
      await this.createAttempts(tx, rows, executor);
      return this.loadClaimed(tx, rows, owner);
    });
  }

  private async createAttempts(
    tx: Prisma.TransactionClient,
    rows: { id: string; attempt_count: number; lease_expires_at: Date }[],
    executor: Executor,
  ): Promise<void> {
    await tx.jobAttempt.createMany({
      data: rows.map((row) => ({
        executionId: row.id,
        attemptNumber: row.attempt_count,
        status: 'RUNNING' as const,
        leaseExpiresAt: row.lease_expires_at,
        ...(executor.kind === 'worker' ? { workerId: executor.workerId } : { agentId: executor.agentId }),
      })),
    });
  }

  private async loadClaimed(
    tx: Prisma.TransactionClient,
    rows: { id: string; attempt_count: number; lease_expires_at: Date }[],
    owner: string,
  ): Promise<ClaimedExecution[]> {
    const executions = await tx.jobExecution.findMany({
      where: { id: { in: rows.map((row) => row.id) } },
      select: {
        id: true,
        jobId: true,
        projectId: true,
        mode: true,
        payload: true,
        idempotencyKey: true,
        scheduledFor: true,
        timeoutMs: true,
        job: { select: { name: true, httpConfig: true } },
      },
      orderBy: { scheduledFor: 'asc' },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return executions.map((execution) => {
      const row = byId.get(execution.id)!;
      return {
        executionId: execution.id,
        attempt: row.attempt_count,
        jobId: execution.jobId,
        projectId: execution.projectId,
        jobName: execution.job.name,
        mode: execution.mode,
        payload: execution.payload,
        idempotencyKey: execution.idempotencyKey,
        scheduledFor: execution.scheduledFor,
        timeoutMs: execution.timeoutMs,
        httpConfig: execution.job.httpConfig,
        leaseExpiresAt: row.lease_expires_at,
        owner,
      };
    });
  }

  /** Extends the lease. false means the attempt is no longer ours (cancelled, reaped): stop. */
  async renewLease(ref: AttemptRef, leaseMs: number): Promise<boolean> {
    const count = await this.prisma.$executeRaw`
      UPDATE job_executions SET lease_expires_at = now() + ${leaseMs} * interval '1 millisecond', updated_at = now()
      WHERE id = ${ref.executionId}::uuid AND status = 'RUNNING' AND lease_owner = ${ref.owner} AND attempt_count = ${ref.attempt}`;
    return count > 0;
  }

  /** Renews several leases held by one owner (agent heartbeats). Returns the ids still held. */
  async renewLeases(owner: string, refs: { executionId: string; attempt: number }[], leaseMs: number): Promise<Set<string>> {
    if (refs.length === 0) return new Set();
    const ids = refs.map((ref) => ref.executionId);
    const attempts = refs.map((ref) => ref.attempt);
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE job_executions e SET lease_expires_at = now() + ${leaseMs} * interval '1 millisecond', updated_at = now()
      FROM unnest(${ids}::uuid[], ${attempts}::int[]) AS r(id, attempt)
      WHERE e.id = r.id AND e.attempt_count = r.attempt AND e.status = 'RUNNING' AND e.lease_owner = ${owner}
      RETURNING e.id`;
    return new Set(rows.map((row) => row.id));
  }

  /** Records success. Returns false when the result is stale and was discarded. */
  async complete(ref: AttemptRef, report: SuccessReport = {}): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const count = await tx.$executeRaw`
        UPDATE job_executions
        SET status = 'SUCCEEDED', finished_at = now(), lease_owner = NULL, lease_expires_at = NULL,
            last_error = NULL, result = ${report.output === undefined ? null : JSON.stringify(report.output)}::jsonb, updated_at = now()
        WHERE id = ${ref.executionId}::uuid AND status = 'RUNNING' AND lease_owner = ${ref.owner} AND attempt_count = ${ref.attempt}`;
      if (count === 0) return false;
      await tx.jobAttempt.update({
        where: { executionId_attemptNumber: { executionId: ref.executionId, attemptNumber: ref.attempt } },
        data: {
          status: 'SUCCEEDED',
          finishedAt: new Date(),
          ...(report.output !== undefined ? { output: report.output } : {}),
          ...(report.httpStatus !== undefined ? { httpStatus: report.httpStatus } : {}),
        },
      });
      return true;
    });
  }

  /** Records a failed attempt. Returns the new execution status, or null if stale. */
  async fail(ref: AttemptRef, report: FailureReport): Promise<ExecutionStatus | null> {
    return this.prisma.$transaction(async (tx) => {
      const row = await this.lock(tx, ref.executionId);
      if (!row || row.status !== 'RUNNING' || row.lease_owner !== ref.owner || row.attempt_count !== ref.attempt) return null;
      return this.applyFailure(tx, row, report, report.timedOut ? 'TIMED_OUT' : report.abandoned ? 'ABANDONED' : 'FAILED');
    });
  }

  private async lock(tx: Prisma.TransactionClient, executionId: string): Promise<LockedExecution | undefined> {
    const rows = await tx.$queryRaw<LockedExecution[]>`
      SELECT e.id, e.status, e.attempt_count, e.max_attempts, e.lease_owner, e.retry_backoff_ms, e.retry_backoff_max_ms
      FROM job_executions e
      WHERE e.id = ${executionId}::uuid
      FOR UPDATE`;
    return rows[0];
  }

  /**
   * Shared by executors and the reaper: closes the current attempt and decides between
   * retry (exponential backoff with jitter), dead letter (retries exhausted) and
   * permanent failure (non-retryable error).
   */
  async applyFailure(
    tx: Prisma.TransactionClient,
    row: LockedExecution,
    report: FailureReport,
    attemptStatus: AttemptStatus,
  ): Promise<ExecutionStatus> {
    const retry = report.retryable && row.attempt_count < row.max_attempts;
    const next: ExecutionStatus = retry ? 'RETRY_SCHEDULED' : report.retryable ? 'DEAD_LETTERED' : 'FAILED';
    const delay = retry ? retryDelayMs(row.attempt_count, row.retry_backoff_ms, row.retry_backoff_max_ms) : 0;
    const message = truncate(report.message, MAX_ERROR_LENGTH);

    await tx.$executeRaw`
      UPDATE job_executions
      SET status = ${next}::"ExecutionStatus", lease_owner = NULL, lease_expires_at = NULL, last_error = ${message},
          next_attempt_at = CASE WHEN ${retry} THEN now() + ${delay} * interval '1 millisecond' ELSE next_attempt_at END,
          finished_at = CASE WHEN ${retry} THEN NULL ELSE now() END,
          updated_at = now()
      WHERE id = ${row.id}::uuid`;
    await tx.jobAttempt.updateMany({
      where: { executionId: row.id, attemptNumber: row.attempt_count, status: 'RUNNING' },
      data: {
        status: attemptStatus,
        finishedAt: new Date(),
        errorMessage: message,
        errorCode: report.code ?? null,
        ...(report.httpStatus !== undefined ? { httpStatus: report.httpStatus } : {}),
        ...(report.output !== undefined ? { output: report.output } : {}),
      },
    });
    return next;
  }

  /** Reaper entry point: fails the current attempt regardless of owner. */
  async failCurrentAttempt(executionId: string, report: FailureReport, attemptStatus: AttemptStatus): Promise<ExecutionStatus | null> {
    return this.prisma.$transaction(async (tx) => {
      const row = await this.lock(tx, executionId);
      if (!row || row.status !== 'RUNNING') return null;
      return this.applyFailure(tx, row, report, attemptStatus);
    });
  }

  /**
   * Cancels a non-terminal execution. A running attempt's late result will be rejected.
   * With `notStartedOnly`, a RUNNING execution is left alone (cancelled: false).
   */
  async cancel(executionId: string, projectId: string, reason = 'cancelled by user', options: { notStartedOnly?: boolean } = {}) {
    return this.prisma.$transaction(async (tx) => {
      const row = await this.lockInProject(tx, executionId, projectId);
      if (!row) return null;
      if (TERMINAL_STATUSES.includes(row.status) || (options.notStartedOnly && row.status === 'RUNNING')) {
        return { cancelled: false as const, status: row.status, owner: null, attempt: row.attempt_count, mode: row.mode };
      }
      await tx.$executeRaw`
        UPDATE job_executions SET status = 'CANCELLED', finished_at = now(), lease_owner = NULL, lease_expires_at = NULL,
               last_error = ${reason}, updated_at = now()
        WHERE id = ${executionId}::uuid`;
      if (row.status === 'RUNNING') {
        await tx.jobAttempt.updateMany({
          where: { executionId, attemptNumber: row.attempt_count, status: 'RUNNING' },
          data: { status: 'FAILED', finishedAt: new Date(), errorCode: 'CANCELLED', errorMessage: reason },
        });
      }
      return { cancelled: true as const, status: 'CANCELLED' as const, owner: row.lease_owner, attempt: row.attempt_count, previous: row.status, mode: row.mode };
    });
  }

  /** Re-runs a dead-lettered, failed or cancelled execution with a fresh attempt budget. */
  async replay(executionId: string, projectId: string): Promise<ExecutionStatus | null> {
    return this.prisma.$transaction(async (tx) => {
      const row = await this.lockInProject(tx, executionId, projectId);
      if (!row) return null;
      if (!['DEAD_LETTERED', 'FAILED', 'CANCELLED'].includes(row.status)) return row.status;
      await tx.$executeRaw`
        UPDATE job_executions e
        SET status = 'PENDING', max_attempts = e.attempt_count + j.max_attempts, next_attempt_at = now(),
            finished_at = NULL, updated_at = now()
        FROM jobs j WHERE j.id = e.job_id AND e.id = ${executionId}::uuid`;
      return 'PENDING';
    });
  }

  private async lockInProject(tx: Prisma.TransactionClient, executionId: string, projectId: string) {
    const rows = await tx.$queryRaw<{ status: ExecutionStatus; attempt_count: number; lease_owner: string | null; mode: 'HTTP' | 'AGENT' | 'WORKER' }[]>`
      SELECT status, attempt_count, lease_owner, mode FROM job_executions
      WHERE id = ${executionId}::uuid AND project_id = ${projectId}::uuid FOR UPDATE`;
    return rows[0];
  }

  /**
   * Creates a manual execution ("run now"). Kept for callers of the original API; it is a
   * submission with trigger MANUAL that rejects FORBID overlaps.
   */
  async trigger(input: { jobId: string; projectId: string; payload?: Prisma.InputJsonValue; idempotencyKey?: string }): Promise<SubmitResult> {
    return this.submit({
      projectId: input.projectId,
      job: { id: input.jobId },
      trigger: 'MANUAL',
      rejectOverlap: true,
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });
  }

  /**
   * Submits a job for immediate or delayed execution. With an idempotency key, repeating
   * the submission returns the original execution (in any state) instead of creating a
   * new one. Manual triggers and queue submissions share the key namespace per job.
   */
  async submit(input: SubmitInput): Promise<SubmitResult> {
    const key = `manual:${input.idempotencyKey ?? randomUUID()}`;
    try {
      return await this.createSubmission(input, key);
    } catch (error) {
      // A concurrent request with the same key won the insert; PostgreSQL has aborted our
      // transaction, so look the winner up outside it.
      if (!isUniqueViolation(error) || !input.idempotencyKey) throw error;
      const job = await this.prisma.job.findFirst({ where: { projectId: input.projectId, ...('id' in input.job ? { id: input.job.id } : { name: input.job.name }) }, select: { id: true } });
      const raced = job ? await this.prisma.jobExecution.findUnique({ where: { jobId_idempotencyKey: { jobId: job.id, idempotencyKey: key } } }) : null;
      if (!raced) throw error;
      return { outcome: 'duplicate', execution: raced };
    }
  }

  private createSubmission(input: SubmitInput, key: string): Promise<SubmitResult> {
    return this.prisma.$transaction(async (tx): Promise<SubmitResult> => {
      const job = await tx.job.findFirst({
        where: { projectId: input.projectId, ...('id' in input.job ? { id: input.job.id } : { name: input.job.name }) },
        select: {
          id: true,
          enabled: true,
          mode: true,
          payload: true,
          maxAttempts: true,
          timeoutMs: true,
          retryBackoffMs: true,
          retryBackoffMaxMs: true,
          concurrencyPolicy: true,
          priority: true,
          payloadSchema: true,
          queue: { select: { id: true, defaultPriority: true } },
        },
      });
      if (!job) return { outcome: 'not_found' };
      const existing = await tx.jobExecution.findUnique({ where: { jobId_idempotencyKey: { jobId: job.id, idempotencyKey: key } } });
      if (existing) return { outcome: 'duplicate', execution: existing };
      if (!job.enabled) return { outcome: 'disabled' };

      let queue = job.queue;
      if (input.queue !== undefined) {
        const found = await tx.queue.findUnique({ where: { projectId_name: { projectId: input.projectId, name: input.queue } }, select: { id: true, defaultPriority: true } });
        if (!found) {
          if (input.queue !== 'default') return { outcome: 'queue_not_found', queue: input.queue };
          const id = (await resolveQueueId(tx, input.projectId, 'default'))!;
          queue = { id, defaultPriority: 50 };
        } else {
          queue = found;
        }
      }

      const payload = input.payload ?? (job.payload as Prisma.InputJsonValue | null) ?? null;
      if (job.payloadSchema && typeof job.payloadSchema === 'object' && !Array.isArray(job.payloadSchema)) {
        const issues = this.payloadValidator.validate(job.payloadSchema as Record<string, unknown>, payload);
        if (issues.length > 0) return { outcome: 'invalid_payload', issues };
      }

      const retryBackoffMs = input.retryBackoffMs ?? job.retryBackoffMs;
      const retryBackoffMaxMs = input.retryBackoffMaxMs ?? Math.max(job.retryBackoffMaxMs, retryBackoffMs);
      if (retryBackoffMaxMs < retryBackoffMs) return { outcome: 'invalid_settings', message: 'retryBackoffMaxMs must be >= retryBackoffMs' };

      if (input.rejectOverlap && job.concurrencyPolicy === 'FORBID') {
        const active = await tx.jobExecution.findFirst({
          where: { jobId: job.id, status: { in: [...ACTIVE_EXECUTION_STATUSES] } },
          select: { id: true },
        });
        if (active) return { outcome: 'overlap', activeExecutionId: active.id };
      }

      // The database clock, like every other scheduling decision: with the application
      // clock ahead of PostgreSQL's, next_attempt_at = <app now> would not be "due" for the
      // dispatcher (next_attempt_at <= now()) until the skew had elapsed.
      const now = await dbNow(tx);
      const dueAt =
        input.delayMs !== undefined
          ? new Date(now.getTime() + input.delayMs)
          : input.runAt !== undefined && input.runAt > now
            ? input.runAt
            : now;
      const execution = await tx.jobExecution.create({
        data: {
          jobId: job.id,
          projectId: input.projectId,
          queueId: queue.id,
          trigger: input.trigger,
          scheduledFor: dueAt,
          idempotencyKey: key,
          mode: job.mode,
          priority: input.priority ?? job.priority ?? queue.defaultPriority,
          payload: payload === null ? Prisma.JsonNull : payload,
          maxAttempts: input.maxAttempts ?? job.maxAttempts,
          timeoutMs: input.timeoutMs ?? job.timeoutMs,
          retryBackoffMs,
          retryBackoffMaxMs,
          nextAttemptAt: dueAt,
        },
      });
      return { outcome: 'created', execution, delayed: dueAt.getTime() > now.getTime() };
    });
  }

  /** Appends a log line to the current attempt (ignored if the attempt is not running). */
  async appendLog(ref: AttemptRef, level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR', message: string, data?: Prisma.InputJsonValue): Promise<boolean> {
    const attempt = await this.prisma.jobAttempt.findFirst({
      where: { executionId: ref.executionId, attemptNumber: ref.attempt, status: 'RUNNING', execution: { leaseOwner: ref.owner } },
      select: { id: true },
    });
    if (!attempt) return false;
    await this.prisma.executionLog.create({
      data: {
        executionId: ref.executionId,
        attemptId: attempt.id,
        level,
        message: truncate(message, MAX_ERROR_LENGTH),
        ...(data !== undefined ? { data } : {}),
      },
    });
    return true;
  }
}
