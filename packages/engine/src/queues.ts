import { Queue } from 'bullmq';
import type { Keyspace } from '@chronos/shared';

/**
 * BullMQ carries deliveries for modes any consumer can process (HTTP webhooks and
 * central workers). Agent executions are not queued in BullMQ: the agent's WebSocket
 * lives on one specific server replica, so replicas claim agent work directly from
 * PostgreSQL and use Redis pub/sub only as a wake-up signal (see AgentWorkSignal).
 */
export const EXECUTION_QUEUES = {
  HTTP: 'executions-http',
  WORKER: 'executions-worker',
} as const;

export type QueuedMode = keyof typeof EXECUTION_QUEUES;

export interface ExecutionJobData {
  executionId: string;
  attempt: number;
}

/**
 * One BullMQ job per attempt. Re-adding the same attempt is a no-op while the job
 * exists, and the next attempt gets a fresh id. Delivery is still guarded by the
 * conditional claim in PostgreSQL, so a duplicate delivery can never run twice.
 */
export function bullJobId(executionId: string, attempt: number): string {
  return `${executionId}-${attempt}`;
}

/**
 * Chronos priority (0-100, higher first) to BullMQ priority (1 = highest; larger runs
 * later). Every job gets a priority, so all deliveries of a mode share one ordering.
 */
export function bullPriority(priority: number): number {
  return 101 - Math.min(100, Math.max(0, Math.round(priority)));
}

const LIVE_STATES = new Set(['waiting', 'delayed', 'active', 'prioritized', 'waiting-children']);

export class ExecutionQueues {
  constructor(private readonly queueFor: (name: string) => Queue) {}

  queue(mode: QueuedMode): Queue<ExecutionJobData> {
    return this.queueFor(EXECUTION_QUEUES[mode]) as Queue<ExecutionJobData>;
  }

  async enqueue(mode: QueuedMode, executionId: string, attempt: number, priority = 50): Promise<void> {
    await this.queue(mode).add(
      'execute',
      { executionId, attempt },
      {
        jobId: bullJobId(executionId, attempt),
        priority: bullPriority(priority),
        // Retries are owned by PostgreSQL (attempt rows, backoff, dead letters), not BullMQ.
        attempts: 1,
        removeOnComplete: { age: 3600, count: 10_000 },
        removeOnFail: { age: 24 * 3600, count: 10_000 },
      },
    );
  }

  /** Makes sure a QUEUED execution has a live delivery (used by the stale sweeper). */
  async ensureEnqueued(mode: QueuedMode, executionId: string, attempt: number, priority = 50): Promise<'present' | 'requeued'> {
    const queue = this.queue(mode);
    const existing = await queue.getJob(bullJobId(executionId, attempt));
    if (existing) {
      const state = await existing.getState();
      if (LIVE_STATES.has(state)) return 'present';
      await existing.remove();
    }
    await this.enqueue(mode, executionId, attempt, priority);
    return 'requeued';
  }

  /**
   * Best-effort removal of a not-yet-started delivery (after a cancellation). A delivery
   * that is already active, or a failure here, is harmless: the claim in PostgreSQL
   * refuses executions that are no longer QUEUED.
   */
  async remove(mode: QueuedMode, executionId: string, attempt: number): Promise<boolean> {
    const job = await this.queue(mode).getJob(bullJobId(executionId, attempt));
    if (!job) return false;
    try {
      await job.remove();
      return true;
    } catch {
      return false; // locked by a worker that already picked it up
    }
  }
}

/** Redis channel that wakes server replicas holding agents for a project. */
export function agentWorkChannel(keyspace: Keyspace, projectId: string): string {
  return keyspace.key('agent-work', projectId);
}

/** Redis channel asking scheduler runtimes to dispatch now (a submission became due). */
export function dispatchWakeChannel(keyspace: Keyspace): string {
  return keyspace.key('dispatch-wake');
}
