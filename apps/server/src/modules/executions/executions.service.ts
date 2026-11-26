import { Injectable } from '@nestjs/common';
import { ExecutionStatus, Prisma } from '@chronos/database';
import { ExecutionQueues, ExecutionStore } from '@chronos/engine';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { CancelSignal } from '../../infrastructure/engine/agent-work-signal';
import { AppException } from '../../common/http/app-exception';
import type { Principal } from '../../common/http/request-context';
import { AuditService } from '../audit/audit.service';
import { DELAY_TOLERANCE_MS, isDelayed, publicIdempotencyKey } from '../queues/submissions.service';
import type { RequestMeta } from '../auth/auth.service';
import type { ListExecutionsQuery, ListLogsQuery, StatsQuery, TimeseriesQuery } from './executions.schemas';

const DETAIL_LOG_LIMIT = 500;

type ExecutionMode = 'HTTP' | 'AGENT' | 'WORKER';
type ExecutionKind = 'scheduled' | 'manual' | 'immediate' | 'delayed';

/**
 * How an execution came to exist. Queue submissions count as delayed when they were due
 * more than 2 s after they were created (the slack absorbs app/database clock skew).
 */
const KIND_SQL = Prisma.sql`CASE WHEN e.trigger = 'SCHEDULE' THEN 'scheduled' WHEN e.trigger = 'MANUAL' THEN 'manual'
  WHEN e.scheduled_for > e.created_at + interval '2 seconds' THEN 'delayed' ELSE 'immediate' END`;

function executorOf(attempt: { agent: { id: string; hostname: string | null; instanceId: string } | null; worker: { id: string; hostname: string | null; instanceId: string } | null } | undefined) {
  if (attempt?.agent) return { kind: 'AGENT' as const, id: attempt.agent.id, name: attempt.agent.hostname ?? attempt.agent.instanceId };
  if (attempt?.worker) return { kind: 'WORKER' as const, id: attempt.worker.id, name: attempt.worker.hostname ?? attempt.worker.instanceId };
  return null;
}

function kindCounts(rows: { key: ExecutionKind; n: number }[]): Record<ExecutionKind, number> {
  const counts: Record<ExecutionKind, number> = { scheduled: 0, manual: 0, immediate: 0, delayed: 0 };
  for (const row of rows) counts[row.key] = row.n;
  return counts;
}

function round(value: number | null | undefined): number | null {
  return value === null || value === undefined ? null : Math.round(Number(value));
}

const listSelect = {
  id: true,
  jobId: true,
  trigger: true,
  status: true,
  mode: true,
  scheduledFor: true,
  idempotencyKey: true,
  attemptCount: true,
  maxAttempts: true,
  nextAttemptAt: true,
  startedAt: true,
  finishedAt: true,
  lastError: true,
  createdAt: true,
  priority: true,
  job: { select: { name: true } },
  queue: { select: { name: true } },
  // Who ran the latest attempt ("executed by").
  attempts: {
    orderBy: { attemptNumber: 'desc' },
    take: 1,
    select: { agent: { select: { id: true, hostname: true, instanceId: true } }, worker: { select: { id: true, hostname: true, instanceId: true } } },
  },
} satisfies Prisma.JobExecutionSelect;

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [createdAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const date = new Date(createdAt ?? '');
  if (!id || Number.isNaN(date.getTime())) throw AppException.badRequest('Invalid cursor');
  return { createdAt: date, id };
}

@Injectable()
export class ExecutionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: ExecutionStore,
    private readonly cancelSignal: CancelSignal,
    private readonly audit: AuditService,
    private readonly queues: ExecutionQueues,
  ) {}

  /** Keyset pagination (newest first): stable under concurrent inserts, O(limit) per page. */
  async list(projectId: string, query: ListExecutionsQuery) {
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const rows = await this.prisma.jobExecution.findMany({
      where: {
        projectId,
        ...(query.jobId ? { jobId: query.jobId } : {}),
        ...(query.status ? { status: { in: query.status } } : {}),
        ...(query.trigger ? { trigger: query.trigger } : {}),
        ...(query.queue ? { queue: { name: query.queue } } : {}),
        ...(query.agentId ? { attempts: { some: { agentId: query.agentId } } } : {}),
        ...(query.workerId ? { attempts: { some: { workerId: query.workerId } } } : {}),
        ...(query.delayed === true ? { status: 'PENDING' as const, nextAttemptAt: { gt: new Date(Date.now() + DELAY_TOLERANCE_MS) } } : {}),
        ...(query.delayed === false ? { NOT: { status: 'PENDING' as const, nextAttemptAt: { gt: new Date(Date.now() + DELAY_TOLERANCE_MS) } } } : {}),
        ...(query.mode ? { mode: query.mode } : {}),
        ...(query.from || query.to ? { createdAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } } : {}),
        ...(cursor
          ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }
          : {}),
      },
      select: listSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(({ job, queue, attempts, ...rest }) => ({
        ...rest,
        executor: executorOf(attempts[0]),
        idempotencyKey: publicIdempotencyKey(rest.idempotencyKey),
        jobName: job.name,
        queue: queue?.name ?? null,
        delayed: isDelayed(rest),
      })),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null,
    };
  }

  async get(projectId: string, executionId: string) {
    const execution = await this.prisma.jobExecution.findFirst({
      where: { id: executionId, projectId },
      include: {
        job: { select: { name: true } },
        queue: { select: { name: true } },
        attempts: {
          orderBy: { attemptNumber: 'asc' },
          include: { agent: { select: { id: true, hostname: true, instanceId: true } }, worker: { select: { id: true, hostname: true, instanceId: true } } },
        },
        logs: { orderBy: { id: 'asc' }, take: DETAIL_LOG_LIMIT + 1 },
      },
    });
    if (!execution) throw AppException.notFound('Execution');
    const { job, logs, queue, ...rest } = execution;
    return {
      ...rest,
      idempotencyKey: publicIdempotencyKey(rest.idempotencyKey),
      jobName: job.name,
      queue: queue?.name ?? null,
      delayed: isDelayed(rest),
      logs: logs.slice(0, DETAIL_LOG_LIMIT).map((log) => ({ ...log, id: log.id.toString() })),
      /** True when more log entries exist; page through them with GET .../logs. */
      logsTruncated: logs.length > DETAIL_LOG_LIMIT,
    };
  }

  /** Log entries in insertion order, for paging and live tailing (poll with `afterId`). */
  async logs(projectId: string, executionId: string, query: ListLogsQuery) {
    const exists = await this.prisma.jobExecution.findFirst({ where: { id: executionId, projectId }, select: { id: true } });
    if (!exists) throw AppException.notFound('Execution');
    const rows = await this.prisma.executionLog.findMany({
      where: { executionId, ...(query.afterId ? { id: { gt: BigInt(query.afterId) } } : {}) },
      orderBy: { id: 'asc' },
      take: query.limit,
    });
    const last = rows[rows.length - 1];
    return {
      items: rows.map((log) => ({ ...log, id: log.id.toString() })),
      // Returned even for an empty page so clients can keep tailing from it.
      nextAfterId: last ? last.id.toString() : (query.afterId ?? null),
    };
  }

  /**
   * Cancels an execution. Not-yet-started executions (pending, delayed, queued, waiting
   * for a retry) are cancelled definitively. Running ones get a best-effort stop signal.
   * Agent tokens (SDK `chronos.cancel()`) may only cancel executions that have not started.
   */
  async cancel(projectId: string, organizationId: string, executionId: string, principal: Principal, meta: RequestMeta) {
    const notStartedOnly = principal.type === 'agent';
    const result = await this.store.cancel(executionId, projectId, 'cancelled by user', { notStartedOnly });
    if (!result) throw AppException.notFound('Execution');
    if (!result.cancelled) {
      if (result.status === 'RUNNING') throw AppException.conflict('Execution has already started; agent tokens can only cancel executions that have not started');
      throw AppException.conflict(`Execution already finished with status ${result.status}`);
    }
    if (result.previous === 'QUEUED' && result.mode !== 'AGENT') {
      // Drop the pending delivery; if a worker already took it, its claim is refused.
      await this.queues.remove(result.mode, executionId, result.attempt + 1).catch(() => false);
    }
    if (result.owner) {
      // Best effort: the executor also notices on its next lease renewal.
      await this.cancelSignal.publish({ executionId, attempt: result.attempt, owner: result.owner }).catch(() => undefined);
    }
    await this.audit.record({ action: 'execution.cancelled', principal, organizationId, projectId, targetType: 'execution', targetId: executionId, requestId: meta.requestId });
    return { id: executionId, status: 'CANCELLED' as const, previousStatus: result.previous };
  }

  async replay(projectId: string, organizationId: string, executionId: string, principal: Principal, meta: RequestMeta) {
    const status = await this.store.replay(executionId, projectId);
    if (!status) throw AppException.notFound('Execution');
    if (status !== 'PENDING') throw AppException.conflict(`Only failed, dead-lettered or cancelled executions can be retried (status ${status})`);
    await this.audit.record({ action: 'execution.replayed', principal, organizationId, projectId, targetType: 'execution', targetId: executionId, requestId: meta.requestId });
    return { id: executionId, status };
  }

  /** Execution counts by status over a recent window, for dashboards. */
  /** SQL filter shared by stats and time series. */
  private scope(projectId: string, query: { jobId?: string | undefined; queue?: string | undefined; mode?: string | undefined }): Prisma.Sql {
    return Prisma.sql`e.project_id = ${projectId}::uuid
      ${query.jobId ? Prisma.sql`AND e.job_id = ${query.jobId}::uuid` : Prisma.empty}
      ${query.queue ? Prisma.sql`AND e.queue_id = (SELECT id FROM queues WHERE project_id = ${projectId}::uuid AND name = ${query.queue})` : Prisma.empty}
      ${query.mode ? Prisma.sql`AND e.mode = ${query.mode}::"ExecutionMode"` : Prisma.empty}`;
  }

  /**
   * Execution counts over a recent window, for dashboards: by status, by execution mode and
   * by kind (scheduled / manual / immediate / delayed submission), plus job and agent
   * counts and the duration percentiles of successful executions.
   */
  async stats(projectId: string, query: StatsQuery) {
    const since = new Date(Date.now() - query.hours * 3600_000);
    const scope = this.scope(projectId, query);
    const [statusRows, modeRows, kindRows, durations, jobs, jobsEnabled, jobsPaused, agentsOnline] = await Promise.all([
      this.prisma.$queryRaw<{ key: ExecutionStatus; n: number }[]>`
        SELECT e.status AS key, count(*)::int AS n FROM job_executions e WHERE ${scope} AND e.created_at >= ${since} GROUP BY 1`,
      this.prisma.$queryRaw<{ key: ExecutionMode; n: number }[]>`
        SELECT e.mode AS key, count(*)::int AS n FROM job_executions e WHERE ${scope} AND e.created_at >= ${since} GROUP BY 1`,
      this.prisma.$queryRaw<{ key: ExecutionKind; n: number }[]>`
        SELECT ${KIND_SQL} AS key, count(*)::int AS n FROM job_executions e WHERE ${scope} AND e.created_at >= ${since} GROUP BY 1`,
      this.prisma.$queryRaw<{ p50: number | null; p95: number | null }[]>`
        SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (e.finished_at - e.started_at)) * 1000) AS p50,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (e.finished_at - e.started_at)) * 1000) AS p95
        FROM job_executions e
        WHERE ${scope} AND e.status = 'SUCCEEDED' AND e.created_at >= ${since} AND e.started_at IS NOT NULL AND e.finished_at IS NOT NULL`,
      this.prisma.job.count({ where: { projectId } }),
      this.prisma.job.count({ where: { projectId, enabled: true } }),
      this.prisma.jobSchedule.count({ where: { state: 'PAUSED', job: { projectId } } }),
      this.prisma.agent.count({ where: { projectId, status: 'ONLINE' } }),
    ]);
    return {
      windowHours: query.hours,
      jobId: query.jobId ?? null,
      queue: query.queue ?? null,
      executions: Object.fromEntries(statusRows.map((row) => [row.key, row.n])) as Partial<Record<ExecutionStatus, number>>,
      byMode: Object.fromEntries(modeRows.map((row) => [row.key, row.n])) as Partial<Record<ExecutionMode, number>>,
      byKind: kindCounts(kindRows),
      jobs,
      jobsEnabled,
      jobsPaused,
      agentsOnline,
      /** First start to finish of successful executions (includes time spent on retries). */
      durationMs: { p50: round(durations[0]?.p50), p95: round(durations[0]?.p95) },
    };
  }

  /**
   * Per-bucket (UTC hour or day) execution counts by status, mode and kind, and duration
   * percentiles of successful executions. Oldest first; empty buckets are included.
   */
  async timeseries(projectId: string, query: TimeseriesQuery) {
    const bucketMs = query.bucket === 'hour' ? 3600_000 : 86_400_000;
    const now = Date.now();
    const start = Math.floor((now - query.hours * 3600_000) / bucketMs) * bucketMs;
    const scope = this.scope(projectId, query);
    const bucket = Prisma.sql`(date_trunc(${query.bucket}, e.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;
    const [statusRows, modeRows, kindRows, durationRows] = await Promise.all([
      this.prisma.$queryRaw<{ bucket: Date; key: ExecutionStatus; n: number }[]>`
        SELECT ${bucket} AS bucket, e.status AS key, count(*)::int AS n FROM job_executions e WHERE ${scope} AND e.created_at >= ${new Date(start)} GROUP BY 1, 2`,
      this.prisma.$queryRaw<{ bucket: Date; key: ExecutionMode; n: number }[]>`
        SELECT ${bucket} AS bucket, e.mode AS key, count(*)::int AS n FROM job_executions e WHERE ${scope} AND e.created_at >= ${new Date(start)} GROUP BY 1, 2`,
      this.prisma.$queryRaw<{ bucket: Date; key: ExecutionKind; n: number }[]>`
        SELECT ${bucket} AS bucket, ${KIND_SQL} AS key, count(*)::int AS n FROM job_executions e WHERE ${scope} AND e.created_at >= ${new Date(start)} GROUP BY 1, 2`,
      this.prisma.$queryRaw<{ bucket: Date; p50: number | null; p95: number | null }[]>`
        SELECT ${bucket} AS bucket,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (e.finished_at - e.started_at)) * 1000) AS p50,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (e.finished_at - e.started_at)) * 1000) AS p95
        FROM job_executions e
        WHERE ${scope} AND e.created_at >= ${new Date(start)} AND e.status = 'SUCCEEDED' AND e.started_at IS NOT NULL AND e.finished_at IS NOT NULL
        GROUP BY 1`,
    ]);
    type Point = {
      counts: Partial<Record<ExecutionStatus, number>>;
      byMode: Partial<Record<ExecutionMode, number>>;
      byKind: Record<ExecutionKind, number>;
      durationMs: { p50: number | null; p95: number | null };
    };
    const points = new Map<number, Point>();
    for (let at = start; at <= now; at += bucketMs) {
      points.set(at, { counts: {}, byMode: {}, byKind: { scheduled: 0, manual: 0, immediate: 0, delayed: 0 }, durationMs: { p50: null, p95: null } });
    }
    const at = (row: { bucket: Date }) => points.get(new Date(row.bucket).getTime());
    for (const row of statusRows) {
      const point = at(row);
      if (point) point.counts[row.key] = row.n;
    }
    for (const row of modeRows) {
      const point = at(row);
      if (point) point.byMode[row.key] = row.n;
    }
    for (const row of kindRows) {
      const point = at(row);
      if (point) point.byKind[row.key] = row.n;
    }
    for (const row of durationRows) {
      const point = at(row);
      if (point) point.durationMs = { p50: round(row.p50), p95: round(row.p95) };
    }
    return {
      bucket: query.bucket,
      windowHours: query.hours,
      points: [...points.entries()].map(([time, point]) => ({ at: new Date(time), ...point })),
    };
  }
}
