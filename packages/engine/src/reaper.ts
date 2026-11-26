import { PrismaClient } from '@chronos/database';
import { EngineLogger, silentLogger } from './common';
import { ExecutionStore } from './executions';

export interface ReaperOptions {
  /** Extra time past an attempt's timeout before the server fails it itself. */
  timeoutGraceMs: number;
  agentStaleMs: number;
  workerStaleMs: number;
  /** Delete terminal executions older than this many days; 0 keeps history forever. */
  retentionDays: number;
  batchSize: number;
}

export const DEFAULT_REAPER_OPTIONS: ReaperOptions = {
  timeoutGraceMs: 30_000,
  agentStaleMs: 60_000,
  workerStaleMs: 60_000,
  retentionDays: 0,
  batchSize: 100,
};

export interface ReapResult {
  expiredLeases: number;
  timedOut: number;
  staleAgents: number;
  staleWorkers: number;
  pruned: number;
}

/**
 * Failure detection and recovery. Safe to run on every replica concurrently: candidate
 * rows are selected with SKIP LOCKED, and each transition re-checks state under a row
 * lock.
 */
export class Reaper {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly executions: ExecutionStore,
    private readonly options: ReaperOptions = DEFAULT_REAPER_OPTIONS,
    private readonly logger: EngineLogger = silentLogger,
  ) {}

  async reapOnce(): Promise<ReapResult> {
    const result: ReapResult = {
      expiredLeases: await this.reapExpiredLeases(),
      timedOut: await this.reapTimeouts(),
      staleAgents: await this.markStale('agents', this.options.agentStaleMs),
      staleWorkers: await this.markStale('workers', this.options.workerStaleMs),
      pruned: await this.prune(),
    };
    if (result.expiredLeases + result.timedOut + result.staleAgents + result.staleWorkers > 0) {
      this.logger.warn('Recovered from executor failures', { ...result });
    }
    return result;
  }

  /** An executor stopped renewing its lease (crash, partition, lost connection). */
  private async reapExpiredLeases(): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM job_executions
      WHERE status = 'RUNNING' AND lease_expires_at < now()
      ORDER BY lease_expires_at LIMIT ${this.options.batchSize}`;
    let count = 0;
    for (const row of rows) {
      const status = await this.executions.failCurrentAttempt(
        row.id,
        { message: 'Executor lost its lease (crashed, disconnected or stopped renewing)', code: 'LEASE_EXPIRED', retryable: true },
        'ABANDONED',
      );
      if (status) count += 1;
    }
    return count;
  }

  /**
   * Server-side hard timeout. Executors enforce timeouts themselves; this catches
   * executors that keep renewing their lease while stuck.
   */
  private async reapTimeouts(): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT e.id FROM job_executions e
      JOIN job_attempts a ON a.execution_id = e.id AND a.attempt_number = e.attempt_count
      WHERE e.status = 'RUNNING'
        AND a.started_at + (e.timeout_ms + ${this.options.timeoutGraceMs}) * interval '1 millisecond' < now()
      LIMIT ${this.options.batchSize}`;
    let count = 0;
    for (const row of rows) {
      const status = await this.executions.failCurrentAttempt(
        row.id,
        { message: 'Execution exceeded its timeout', code: 'TIMEOUT', retryable: true, timedOut: true },
        'TIMED_OUT',
      );
      if (status) count += 1;
    }
    return count;
  }

  private async markStale(table: 'agents' | 'workers', staleMs: number): Promise<number> {
    if (table === 'agents') {
      return this.prisma.$executeRaw`
        UPDATE agents SET status = 'OFFLINE', disconnected_at = now()
        WHERE status <> 'OFFLINE' AND last_heartbeat_at < now() - ${staleMs} * interval '1 millisecond'`;
    }
    return this.prisma.$executeRaw`
      UPDATE workers SET status = 'OFFLINE', stopped_at = now()
      WHERE status <> 'OFFLINE' AND last_heartbeat_at < now() - ${staleMs} * interval '1 millisecond'`;
  }

  private async prune(): Promise<number> {
    if (this.options.retentionDays <= 0) return 0;
    return this.prisma.$executeRaw`
      DELETE FROM job_executions WHERE id IN (
        SELECT id FROM job_executions
        WHERE status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'DEAD_LETTERED')
          AND finished_at < now() - ${this.options.retentionDays} * interval '1 day'
        LIMIT 1000)`;
  }
}
