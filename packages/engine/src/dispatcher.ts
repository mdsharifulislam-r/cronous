import { Prisma, PrismaClient } from '@chronos/database';
import { EngineLogger, errorMessage, silentLogger } from './common';
import { ExecutionQueues } from './queues';

interface DispatchRow {
  id: string;
  mode: 'HTTP' | 'AGENT' | 'WORKER';
  project_id: string;
  attempt_count: number;
  queue_id: string | null;
  job_id: string;
  priority: number;
}

export interface DispatcherDeps {
  prisma: PrismaClient;
  queues: ExecutionQueues;
  /** Wakes the replicas holding agents for these projects (Redis PUBLISH). */
  notifyAgents: (projectIds: string[]) => Promise<void>;
  logger?: EngineLogger;
}

/** Statuses that occupy a concurrency slot: admitted and not yet finished or failed. */
const OCCUPYING = Prisma.sql`('QUEUED', 'RUNNING')`;

/**
 * Transactional outbox plus admission control.
 *
 * Executions are first committed as PENDING (or RETRY_SCHEDULED after a failure, or a
 * PENDING row with a future `next_attempt_at` for delayed submissions). The dispatcher
 * admits due rows by marking them QUEUED in one transaction, *then* hands them to
 * BullMQ (or wakes agents). If the process dies between the two steps, the row is QUEUED
 * without a delivery, and `sweepStale` re-enqueues it. Nothing is lost, and duplicates
 * are harmless because executors claim rows conditionally.
 *
 * Admission honours, in this order: queue pause, queue `concurrency_limit`, and the
 * job's limit (`max_concurrency`, or 1 for FORBID). A slot is occupied from QUEUED until
 * the attempt ends, so executors never receive more than the limits allow. Limits are
 * serialised across dispatchers with transaction-scoped advisory locks (taken in sorted
 * order), not row locks, so admission never blocks or deadlocks with job/queue edits.
 * Within those limits, higher `priority` first, then earlier `next_attempt_at`.
 */
export class Dispatcher {
  private readonly logger: EngineLogger;

  constructor(
    private readonly deps: DispatcherDeps,
    private readonly options: { batchSize: number; queuedStaleMs: number } = { batchSize: 200, queuedStaleMs: 60_000 },
  ) {
    this.logger = deps.logger ?? silentLogger;
  }

  async dispatch(): Promise<number> {
    const rows = await this.deps.prisma.$transaction((tx) => this.admit(tx), { timeout: 30_000, maxWait: 10_000 });
    if (rows.length === 0) return 0;

    const agentProjects = new Set<string>();
    await Promise.all(
      rows.map(async (row) => {
        if (row.mode === 'AGENT') {
          agentProjects.add(row.project_id);
          return;
        }
        try {
          await this.deps.queues.enqueue(row.mode, row.id, row.attempt_count + 1, row.priority);
        } catch (error) {
          // The sweeper will retry; the row is durable.
          this.logger.warn('Enqueue failed; will be retried by the stale sweeper', { executionId: row.id, error: errorMessage(error) });
        }
      }),
    );
    if (agentProjects.size > 0) {
      await this.deps.notifyAgents([...agentProjects]).catch((error: unknown) =>
        this.logger.warn('Agent wake-up publish failed; agents will poll', { error: errorMessage(error) }),
      );
    }
    return rows.length;
  }

  private async admit(tx: Prisma.TransactionClient): Promise<DispatchRow[]> {
    // 1. Candidates. Rank due rows per job and then per queue against the remaining
    //    capacity, so a saturated queue or job cannot fill the batch and starve others.
    //    Counts here are unlocked estimates; step 3 re-checks under lock.
    const candidates = await tx.$queryRaw<{ id: string }[]>`
      WITH due AS (
        SELECT e.id, e.queue_id, e.job_id, e.priority, e.next_attempt_at
        FROM job_executions e
        WHERE e.status IN ('PENDING', 'RETRY_SCHEDULED') AND e.next_attempt_at <= now()
      ),
      jcap AS (
        SELECT j.id, GREATEST(j.lim - (SELECT count(*) FROM job_executions a WHERE a.job_id = j.id AND a.status IN ${OCCUPYING}), 0) AS remaining
        FROM (SELECT id, CASE WHEN concurrency_policy = 'FORBID' THEN 1 ELSE max_concurrency END AS lim
              FROM jobs WHERE id IN (SELECT DISTINCT job_id FROM due)) j
        WHERE j.lim IS NOT NULL
      ),
      qcap AS (
        SELECT q.id,
               CASE WHEN q.paused THEN 0
                    WHEN q.concurrency_limit IS NULL THEN NULL
                    ELSE GREATEST(q.concurrency_limit - (SELECT count(*) FROM job_executions a WHERE a.queue_id = q.id AND a.status IN ${OCCUPYING}), 0)
               END AS remaining
        FROM queues q WHERE q.id IN (SELECT DISTINCT queue_id FROM due WHERE queue_id IS NOT NULL)
      ),
      job_ranked AS (
        SELECT d.*, jc.remaining AS jrem,
               row_number() OVER (PARTITION BY d.job_id ORDER BY d.priority DESC, d.next_attempt_at, d.id) AS jrn
        FROM due d LEFT JOIN jcap jc ON jc.id = d.job_id
      ),
      queue_ranked AS (
        SELECT r.id, r.priority, r.next_attempt_at, qc.remaining AS qrem,
               row_number() OVER (PARTITION BY r.queue_id ORDER BY r.priority DESC, r.next_attempt_at, r.id) AS qrn
        FROM job_ranked r LEFT JOIN qcap qc ON qc.id = r.queue_id
        WHERE r.jrem IS NULL OR r.jrn <= r.jrem
      )
      SELECT id FROM queue_ranked
      WHERE qrem IS NULL OR qrn <= qrem
      ORDER BY priority DESC, next_attempt_at, id
      LIMIT ${this.options.batchSize}`;
    if (candidates.length === 0) return [];

    // 2. Lock the candidates. SKIP LOCKED partitions work between concurrent dispatchers.
    const locked = await tx.$queryRaw<DispatchRow[]>`
      SELECT id, mode, project_id, attempt_count, queue_id, job_id, priority FROM job_executions
      WHERE id = ANY(${candidates.map((row) => row.id)}::uuid[])
        AND status IN ('PENDING', 'RETRY_SCHEDULED') AND next_attempt_at <= now()
      ORDER BY priority DESC, next_attempt_at, id
      FOR UPDATE SKIP LOCKED`;
    if (locked.length === 0) return [];

    // 3. Authoritative limits under advisory locks (sorted to avoid lock-order deadlocks).
    const queueIds = [...new Set(locked.map((row) => row.queue_id).filter((id): id is string => id !== null))];
    const jobIds = [...new Set(locked.map((row) => row.job_id))];
    const queues = queueIds.length
      ? await tx.$queryRaw<{ id: string; concurrency_limit: number | null; paused: boolean }[]>`
          SELECT id, concurrency_limit, paused FROM queues WHERE id = ANY(${queueIds}::uuid[])`
      : [];
    const jobs = await tx.$queryRaw<{ id: string; lim: number }[]>`
      SELECT id, CASE WHEN concurrency_policy = 'FORBID' THEN 1 ELSE max_concurrency END AS lim
      FROM jobs WHERE id = ANY(${jobIds}::uuid[]) AND (concurrency_policy = 'FORBID' OR max_concurrency IS NOT NULL)`;
    const limitedQueues = queues.filter((queue) => queue.concurrency_limit !== null && !queue.paused);
    const lockKeys = [...limitedQueues.map((queue) => `queue:${queue.id}`), ...jobs.map((job) => `job:${job.id}`)].sort();
    for (const key of lockKeys) {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${`chronos:admission:${key}`}, 0))`;
    }

    const paused = new Set(queues.filter((queue) => queue.paused).map((queue) => queue.id));
    const queueRemaining = new Map<string, number>();
    if (limitedQueues.length > 0) {
      const counts = await tx.$queryRaw<{ queue_id: string; n: number }[]>`
        SELECT queue_id, count(*)::int AS n FROM job_executions
        WHERE queue_id = ANY(${limitedQueues.map((queue) => queue.id)}::uuid[]) AND status IN ${OCCUPYING}
        GROUP BY queue_id`;
      const byQueue = new Map(counts.map((row) => [row.queue_id, row.n]));
      for (const queue of limitedQueues) queueRemaining.set(queue.id, queue.concurrency_limit! - (byQueue.get(queue.id) ?? 0));
    }
    const jobRemaining = new Map<string, number>();
    if (jobs.length > 0) {
      const counts = await tx.$queryRaw<{ job_id: string; n: number }[]>`
        SELECT job_id, count(*)::int AS n FROM job_executions
        WHERE job_id = ANY(${jobs.map((job) => job.id)}::uuid[]) AND status IN ${OCCUPYING}
        GROUP BY job_id`;
      const byJob = new Map(counts.map((row) => [row.job_id, row.n]));
      for (const job of jobs) jobRemaining.set(job.id, job.lim - (byJob.get(job.id) ?? 0));
    }

    const admitted: DispatchRow[] = [];
    for (const row of locked) {
      if (row.queue_id && paused.has(row.queue_id)) continue;
      const queueLeft = row.queue_id ? queueRemaining.get(row.queue_id) : undefined;
      const jobLeft = jobRemaining.get(row.job_id);
      if ((queueLeft !== undefined && queueLeft <= 0) || (jobLeft !== undefined && jobLeft <= 0)) continue;
      if (queueLeft !== undefined) queueRemaining.set(row.queue_id!, queueLeft - 1);
      if (jobLeft !== undefined) jobRemaining.set(row.job_id, jobLeft - 1);
      admitted.push(row);
    }
    if (admitted.length > 0) {
      await tx.$executeRaw`
        UPDATE job_executions SET status = 'QUEUED', updated_at = now()
        WHERE id = ANY(${admitted.map((row) => row.id)}::uuid[])`;
    }
    return admitted;
  }

  async dispatchUntilDrained(maxRounds = 20): Promise<number> {
    let total = 0;
    for (let round = 0; round < maxRounds; round += 1) {
      const count = await this.dispatch();
      total += count;
      if (count < this.options.batchSize) break;
    }
    return total;
  }

  /** Re-enqueues QUEUED HTTP/WORKER executions whose delivery may have been lost. */
  async sweepStale(): Promise<number> {
    const rows = await this.deps.prisma.$transaction(async (tx) => {
      const stale = await tx.$queryRaw<DispatchRow[]>`
        SELECT id, mode, project_id, attempt_count, queue_id, job_id, priority FROM job_executions
        WHERE status = 'QUEUED' AND mode IN ('HTTP', 'WORKER')
          AND updated_at < now() - ${this.options.queuedStaleMs} * interval '1 millisecond'
        ORDER BY updated_at
        LIMIT 100
        FOR UPDATE SKIP LOCKED`;
      if (stale.length > 0) {
        await tx.$executeRaw`UPDATE job_executions SET updated_at = now() WHERE id = ANY(${stale.map((row) => row.id)}::uuid[])`;
      }
      return stale;
    });

    let requeued = 0;
    for (const row of rows) {
      if (row.mode === 'AGENT') continue;
      try {
        if ((await this.deps.queues.ensureEnqueued(row.mode, row.id, row.attempt_count + 1, row.priority)) === 'requeued') requeued += 1;
      } catch (error) {
        this.logger.warn('Stale sweep enqueue failed', { executionId: row.id, error: errorMessage(error) });
      }
    }
    if (requeued > 0) this.logger.warn('Re-enqueued executions with lost deliveries', { count: requeued });
    return requeued;
  }
}
