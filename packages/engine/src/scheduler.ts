import { Prisma, PrismaClient } from '@chronos/database';
import { occurrenceKey, planDueSchedule } from '@chronos/shared';
import { EngineLogger, dbNow, silentLogger } from './common';

interface DueRow {
  schedule_id: string;
  job_id: string;
  project_id: string;
  type: 'CRON' | 'ONCE';
  cron_expression: string | null;
  run_at: Date | null;
  timezone: string;
  misfire_policy: 'FIRE_ONCE' | 'SKIP' | 'FIRE_ALL';
  misfire_grace_ms: number;
  max_catch_up: number;
  next_run_at: Date;
  mode: 'HTTP' | 'AGENT' | 'WORKER';
  max_attempts: number;
  timeout_ms: number;
  payload: Prisma.JsonValue | null;
  concurrency_policy: 'ALLOW' | 'FORBID';
  queue_id: string;
  priority: number;
  retry_backoff_ms: number;
  retry_backoff_max_ms: number;
}

export interface TickResult {
  schedulesProcessed: number;
  executionsCreated: number;
  occurrencesDropped: number;
  skippedForOverlap: number;
}

export const ACTIVE_EXECUTION_STATUSES = ['PENDING', 'QUEUED', 'RUNNING', 'RETRY_SCHEDULED'] as const;

/**
 * Turns due schedules into durable PENDING executions.
 *
 * Correctness across replicas comes from PostgreSQL, not Redis:
 * 1. Due rows are claimed with `FOR UPDATE SKIP LOCKED`, so concurrent ticks partition
 *    the work instead of blocking on or double-processing it.
 * 2. Each occurrence is inserted with the idempotency key `sched:<ISO time>`, unique per
 *    job, with ON CONFLICT DO NOTHING. Even if two transactions processed the same
 *    occurrence, only one execution could exist.
 * 3. `next_run_at` is advanced in the same transaction, using the database clock.
 */
export class SchedulerEngine {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: { batchSize: number } = { batchSize: 100 },
    private readonly logger: EngineLogger = silentLogger,
  ) {}

  async tick(): Promise<TickResult> {
    return this.prisma.$transaction(
      async (tx) => {
        const now = await dbNow(tx);
        const rows = await tx.$queryRaw<DueRow[]>`
          SELECT s.id AS schedule_id, s.job_id, j.project_id, s.type, s.cron_expression, s.run_at, s.timezone,
                 s.misfire_policy, s.misfire_grace_ms, s.max_catch_up, s.next_run_at,
                 j.mode, j.max_attempts, j.timeout_ms, j.payload, j.concurrency_policy,
                 j.queue_id, COALESCE(j.priority, q.default_priority) AS priority, j.retry_backoff_ms, j.retry_backoff_max_ms
          FROM job_schedules s
          JOIN jobs j ON j.id = s.job_id
          JOIN queues q ON q.id = j.queue_id
          JOIN projects p ON p.id = j.project_id
          WHERE s.state = 'ACTIVE' AND s.next_run_at <= ${now} AND j.enabled AND p.archived_at IS NULL
          ORDER BY s.next_run_at
          LIMIT ${this.options.batchSize}
          FOR UPDATE OF s SKIP LOCKED`;

        const result: TickResult = { schedulesProcessed: rows.length, executionsCreated: 0, occurrencesDropped: 0, skippedForOverlap: 0 };
        for (const row of rows) {
          await this.processRow(tx, row, now, result);
        }
        return result;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
  }

  /** Runs ticks until a batch comes back smaller than the batch size. */
  async tickUntilDrained(maxRounds = 20): Promise<TickResult> {
    const total: TickResult = { schedulesProcessed: 0, executionsCreated: 0, occurrencesDropped: 0, skippedForOverlap: 0 };
    for (let round = 0; round < maxRounds; round += 1) {
      const result = await this.tick();
      total.schedulesProcessed += result.schedulesProcessed;
      total.executionsCreated += result.executionsCreated;
      total.occurrencesDropped += result.occurrencesDropped;
      total.skippedForOverlap += result.skippedForOverlap;
      if (result.schedulesProcessed < this.options.batchSize) break;
    }
    return total;
  }

  private async processRow(tx: Prisma.TransactionClient, row: DueRow, now: Date, result: TickResult): Promise<void> {
    let plan;
    try {
      plan = planDueSchedule(
        {
          type: row.type,
          cronExpression: row.cron_expression,
          runAt: row.run_at,
          timezone: row.timezone,
          misfirePolicy: row.misfire_policy,
          misfireGraceMs: row.misfire_grace_ms,
          maxCatchUp: row.max_catch_up,
          nextRunAt: row.next_run_at,
        },
        now,
      );
    } catch (error) {
      // A definition that can no longer be evaluated (e.g. a zone removed from ICU data)
      // must not block the whole batch: pause it and surface the reason.
      this.logger.error('Pausing schedule that cannot be evaluated', { scheduleId: row.schedule_id, error: String(error) });
      await tx.jobSchedule.update({ where: { id: row.schedule_id }, data: { state: 'PAUSED', nextRunAt: null } });
      return;
    }

    let fire = plan.fire;
    if (row.concurrency_policy === 'FORBID' && fire.length > 0) {
      const active = await tx.jobExecution.findFirst({
        where: { jobId: row.job_id, status: { in: [...ACTIVE_EXECUTION_STATUSES] } },
        select: { id: true },
      });
      if (active) {
        result.skippedForOverlap += fire.length;
        fire = [];
      } else if (fire.length > 1) {
        // Overlap forbidden: catch-up runs would overlap each other, keep only the latest.
        result.skippedForOverlap += fire.length - 1;
        fire = fire.slice(-1);
      }
    }

    if (fire.length > 0) {
      const created = await tx.jobExecution.createMany({
        data: fire.map((occurrence) => ({
          jobId: row.job_id,
          projectId: row.project_id,
          trigger: 'SCHEDULE' as const,
          scheduledFor: occurrence,
          idempotencyKey: occurrenceKey(occurrence),
          mode: row.mode,
          payload: row.payload ?? Prisma.JsonNull,
          maxAttempts: row.max_attempts,
          timeoutMs: row.timeout_ms,
          queueId: row.queue_id,
          priority: row.priority,
          retryBackoffMs: row.retry_backoff_ms,
          retryBackoffMaxMs: row.retry_backoff_max_ms,
          nextAttemptAt: occurrence,
        })),
        skipDuplicates: true,
      });
      result.executionsCreated += created.count;
    }
    result.occurrencesDropped += plan.dropped;

    const lastFired = fire[fire.length - 1];
    await tx.jobSchedule.update({
      where: { id: row.schedule_id },
      data: {
        nextRunAt: plan.nextRunAt,
        state: plan.completed ? 'COMPLETED' : 'ACTIVE',
        ...(lastFired ? { lastScheduledAt: lastFired } : {}),
      },
    });
  }
}
