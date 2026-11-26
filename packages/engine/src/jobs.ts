import { JobSchedule, Prisma } from '@chronos/database';
import type { AgentTaskDefinition, ScheduleDefinition } from '@chronos/protocol';
import { DEFAULT_QUEUE } from '@chronos/protocol';
import { initialNextRunAt } from '@chronos/shared';
import type { Db } from './common';

export interface ScheduleSpec {
  type: 'CRON' | 'ONCE';
  cronExpression: string | null;
  runAt: Date | null;
  timezone: string;
  misfirePolicy: 'FIRE_ONCE' | 'SKIP' | 'FIRE_ALL';
  misfireGraceMs: number;
  maxCatchUp: number;
}

export function scheduleSpecFrom(definition: ScheduleDefinition, defaultTimeZone: string): ScheduleSpec {
  return {
    type: definition.cron ? 'CRON' : 'ONCE',
    cronExpression: definition.cron ?? null,
    runAt: definition.runAt ?? null,
    timezone: definition.timezone ?? defaultTimeZone,
    misfirePolicy: definition.misfirePolicy,
    misfireGraceMs: definition.misfireGraceMs,
    maxCatchUp: definition.maxCatchUp,
  };
}

function timingChanged(existing: JobSchedule, spec: ScheduleSpec): boolean {
  return (
    existing.type !== spec.type ||
    existing.cronExpression !== spec.cronExpression ||
    (existing.runAt?.getTime() ?? null) !== (spec.runAt?.getTime() ?? null) ||
    existing.timezone !== spec.timezone
  );
}

/**
 * Creates, updates or removes a job's schedule.
 *
 * `nextRunAt` is recomputed only when the timing itself changes. Re-applying an
 * identical definition (an SDK reconnecting, an idempotent API PUT) must not shift
 * the next occurrence or skip a due run. A paused schedule stays paused.
 */
export async function applySchedule(tx: Db, jobId: string, spec: ScheduleSpec | null, now: Date): Promise<JobSchedule | null> {
  const existing = await tx.jobSchedule.findUnique({ where: { jobId } });
  if (!spec) {
    if (existing) await tx.jobSchedule.delete({ where: { jobId } });
    return null;
  }

  const policy = {
    misfirePolicy: spec.misfirePolicy,
    misfireGraceMs: spec.misfireGraceMs,
    maxCatchUp: spec.maxCatchUp,
  };

  if (!existing) {
    return tx.jobSchedule.create({
      data: {
        jobId,
        type: spec.type,
        cronExpression: spec.cronExpression,
        runAt: spec.runAt,
        timezone: spec.timezone,
        ...policy,
        state: 'ACTIVE',
        nextRunAt: initialNextRunAt(spec, now),
      },
    });
  }

  if (timingChanged(existing, spec)) {
    const paused = existing.state === 'PAUSED';
    return tx.jobSchedule.update({
      where: { jobId },
      data: {
        type: spec.type,
        cronExpression: spec.cronExpression,
        runAt: spec.runAt,
        timezone: spec.timezone,
        ...policy,
        // A completed one-time schedule given a new time becomes active again.
        state: paused ? 'PAUSED' : 'ACTIVE',
        nextRunAt: paused ? null : initialNextRunAt(spec, now),
        version: { increment: 1 },
      },
    });
  }

  const policyChanged =
    existing.misfirePolicy !== policy.misfirePolicy ||
    existing.misfireGraceMs !== policy.misfireGraceMs ||
    existing.maxCatchUp !== policy.maxCatchUp;
  if (!policyChanged) return existing;
  return tx.jobSchedule.update({ where: { jobId }, data: { ...policy, version: { increment: 1 } } });
}

/** Stops firing. The paused period is not backfilled on resume. */
export async function pauseSchedule(tx: Db, jobId: string): Promise<JobSchedule | null> {
  const schedule = await tx.jobSchedule.findUnique({ where: { jobId } });
  if (!schedule || schedule.state !== 'ACTIVE') return schedule;
  return tx.jobSchedule.update({
    where: { jobId },
    data: { state: 'PAUSED', nextRunAt: null, version: { increment: 1 } },
  });
}

export async function resumeSchedule(tx: Db, jobId: string, now: Date): Promise<JobSchedule | null> {
  const schedule = await tx.jobSchedule.findUnique({ where: { jobId } });
  if (!schedule || schedule.state !== 'PAUSED') return schedule;
  return tx.jobSchedule.update({
    where: { jobId },
    data: { state: 'ACTIVE', nextRunAt: initialNextRunAt(schedule, now), version: { increment: 1 } },
  });
}

/**
 * Returns the id of a project's queue by name. The "default" queue is created on first
 * use; other queues are created only when `createIfMissing` is set (SDK task
 * declarations, where code is the source of truth). API callers must create queues
 * explicitly so a typo cannot silently create a new lane.
 */
export async function resolveQueueId(
  tx: Db,
  projectId: string,
  name: string = DEFAULT_QUEUE,
  createIfMissing = false,
): Promise<string | null> {
  const existing = await tx.queue.findUnique({ where: { projectId_name: { projectId, name } }, select: { id: true } });
  if (existing) return existing.id;
  if (name !== DEFAULT_QUEUE && !createIfMissing) return null;
  // Concurrent first uses race on the unique index; the loser reads the winner's row.
  const created = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO queues (id, project_id, name, updated_at) VALUES (gen_random_uuid(), ${projectId}::uuid, ${name}, now())
    ON CONFLICT (project_id, name) DO UPDATE SET name = EXCLUDED.name
    RETURNING id`;
  return created[0]!.id;
}

export interface SyncedTask {
  name: string;
  jobId: string;
  managedBy: 'sdk' | 'api';
  nextRunAt: string | null;
}

/**
 * Upserts the tasks an SDK agent declared. SDK-owned jobs are updated to match the
 * code; a job with the same name created through the API keeps its configuration
 * ("api" wins). Operator decisions are never overwritten by a reconnect: `enabled` and
 * the paused state are left alone. Jobs absent from this agent are not deleted,
 * because several services may register different tasks in one project.
 */
export async function syncAgentTasks(
  tx: Prisma.TransactionClient,
  projectId: string,
  defaultTimeZone: string,
  tasks: AgentTaskDefinition[],
  now: Date,
): Promise<SyncedTask[]> {
  const results: SyncedTask[] = [];
  for (const task of tasks) {
    const existing = await tx.job.findUnique({ where: { projectId_name: { projectId, name: task.name } }, select: { id: true, source: true } });
    if (existing && existing.source === 'API') {
      const schedule = await tx.jobSchedule.findUnique({ where: { jobId: existing.id }, select: { nextRunAt: true } });
      results.push({ name: task.name, jobId: existing.id, managedBy: 'api', nextRunAt: schedule?.nextRunAt?.toISOString() ?? null });
      continue;
    }

    const queueId = (await resolveQueueId(tx, projectId, task.queue ?? DEFAULT_QUEUE, true))!;
    const fields = {
      description: task.description ?? null,
      mode: 'AGENT' as const,
      queueId,
      timeoutMs: task.timeoutMs,
      maxAttempts: task.maxAttempts,
      retryBackoffMs: task.retryBackoffMs,
      retryBackoffMaxMs: task.retryBackoffMaxMs,
      concurrencyPolicy: task.concurrencyPolicy,
      maxConcurrency: task.maxConcurrency ?? null,
      priority: task.priority ?? null,
      payloadSchema: task.payloadSchema === undefined ? Prisma.JsonNull : (task.payloadSchema as Prisma.InputJsonValue),
    };
    const job = existing
      ? await tx.job.update({ where: { id: existing.id }, data: fields, select: { id: true } })
      : await tx.job.create({ data: { ...fields, projectId, name: task.name, source: 'SDK' }, select: { id: true } });

    const schedule = await applySchedule(tx, job.id, task.schedule ? scheduleSpecFrom(task.schedule, defaultTimeZone) : null, now);
    results.push({ name: task.name, jobId: job.id, managedBy: 'sdk', nextRunAt: schedule?.nextRunAt?.toISOString() ?? null });
  }
  return results;
}
