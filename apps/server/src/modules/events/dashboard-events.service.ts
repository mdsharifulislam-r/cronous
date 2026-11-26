import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@chronos/database';
import { dbNow } from '@chronos/engine';
import { APP_CONFIG } from '../../config/config.module';
import { ServerEnv } from '../../config/env.schema';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/** Event types delivered on the dashboard stream. */
export type DashboardEventType = 'execution.updated' | 'agent.updated' | 'worker.updated';

export interface DashboardEvent {
  type: DashboardEventType;
  data: Record<string, unknown>;
}

export interface EventSubscriber {
  projectId: string;
  /** Whether this subscriber receives installation-wide worker events. */
  includeWorkers: boolean;
  send(event: DashboardEvent): void;
  close(reason: string): void;
}

/**
 * Changes are found by polling, not pushed by writers: executions are updated by many
 * processes (server, scheduler, workers on other hosts), all of which bump `updated_at`.
 * Polling `updated_at` with an overlap window, and de-duplicating on (status, attempt),
 * catches every state transition no matter which process made it, including commits of
 * transactions that started before the previous poll.
 */
const OVERLAP_MS = 10_000;
const BATCH_LIMIT = 1_000;
const SEEN_TTL_MS = 10 * 60_000;
const SEEN_MAX = 50_000;

interface ExecutionChangeRow {
  id: string;
  project_id: string;
  job_id: string;
  job_name: string;
  status: string;
  trigger: string;
  mode: string;
  attempt_count: number;
  max_attempts: number;
  scheduled_for: Date;
  next_attempt_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  last_error: string | null;
  updated_at: Date;
  queue_name: string | null;
  priority: number;
  delayed: boolean;
}

@Injectable()
export class DashboardEventsService implements OnModuleDestroy {
  private readonly logger = new Logger(DashboardEventsService.name);
  private readonly subscribers = new Map<string, Set<EventSubscriber>>();
  private timer?: NodeJS.Timeout;
  private polling = false;
  private stopped = false;
  private since?: Date;
  /** Set while draining a backlog larger than one batch: resume strictly after this row. */
  private catchUp?: { at: Date; id: string };
  private lastPrune = Date.now();
  /** executionId -> last emitted fingerprint (status:attempt) and when it was last seen. */
  private readonly seenExecutions = new Map<string, { fingerprint: string; seenAt: number }>();
  /** Per-project agent statuses; projects enter after their first (silent) poll. */
  private readonly agentStatus = new Map<string, Map<string, string>>();
  private workerStatus?: Map<string, string>;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: ServerEnv,
  ) {}

  get streamCount(): number {
    let count = 0;
    for (const set of this.subscribers.values()) count += set.size;
    return count;
  }

  get canAccept(): boolean {
    return !this.stopped && this.streamCount < this.config.CHRONOS_EVENTS_MAX_STREAMS;
  }

  subscribe(subscriber: EventSubscriber): () => void {
    let set = this.subscribers.get(subscriber.projectId);
    if (!set) {
      set = new Set();
      this.subscribers.set(subscriber.projectId, set);
    }
    set.add(subscriber);
    this.ensureRunning();
    return () => {
      const current = this.subscribers.get(subscriber.projectId);
      current?.delete(subscriber);
      if (current && current.size === 0) {
        this.subscribers.delete(subscriber.projectId);
        this.agentStatus.delete(subscriber.projectId);
      }
      if (this.subscribers.size === 0) this.idle();
    };
  }

  private ensureRunning(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.poll(), this.config.CHRONOS_EVENTS_POLL_MS);
    void this.poll();
  }

  /** No subscribers: stop polling and forget state, so an idle server does no work. */
  private idle(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.since = undefined;
    this.catchUp = undefined;
    this.seenExecutions.clear();
    this.agentStatus.clear();
    this.workerStatus = undefined;
  }

  /** Runs one poll immediately (tests and shutdown use it; normal operation uses the timer). */
  async poll(): Promise<void> {
    if (this.polling || this.subscribers.size === 0) return;
    this.polling = true;
    try {
      const projectIds = [...this.subscribers.keys()];
      const now = await dbNow(this.prisma);
      if (!this.since) this.since = now; // stream changes from now on; history comes from REST
      await this.pollExecutions(projectIds, now);
      await this.pollAgents(projectIds);
      if (this.anyWantsWorkers()) await this.pollWorkers();
    } catch (error) {
      this.logger.warn(`Dashboard change feed poll failed: ${String(error)}`);
    } finally {
      this.polling = false;
    }
  }

  private async pollExecutions(projectIds: string[], now: Date): Promise<void> {
    const since = new Date(this.since!.getTime() - OVERLAP_MS);
    const window = this.catchUp
      ? Prisma.sql`(e.updated_at, e.id) > (${this.catchUp.at}, ${this.catchUp.id}::uuid)`
      : Prisma.sql`e.updated_at > ${since}`;
    const rows = await this.prisma.$queryRaw<ExecutionChangeRow[]>`
      SELECT e.id, e.project_id, e.job_id, j.name AS job_name, e.status, e.trigger, e.mode, e.attempt_count, e.max_attempts,
             e.scheduled_for, e.next_attempt_at, e.started_at, e.finished_at, e.last_error, e.updated_at,
             q.name AS queue_name, e.priority, (e.status = 'PENDING' AND e.next_attempt_at > now()) AS delayed
      FROM job_executions e JOIN jobs j ON j.id = e.job_id LEFT JOIN queues q ON q.id = e.queue_id
      WHERE e.project_id = ANY(${projectIds}::uuid[]) AND ${window}
      ORDER BY e.updated_at, e.id
      LIMIT ${BATCH_LIMIT}`;

    const nowMs = Date.now();
    for (const row of rows) {
      const fingerprint = `${row.status}:${row.attempt_count}`;
      const seen = this.seenExecutions.get(row.id);
      if (seen?.fingerprint === fingerprint) {
        seen.seenAt = nowMs; // lease renewals bump updated_at without a visible change
        continue;
      }
      this.seenExecutions.set(row.id, { fingerprint, seenAt: nowMs });
      this.emit(row.project_id, {
        type: 'execution.updated',
        data: {
          id: row.id,
          jobId: row.job_id,
          jobName: row.job_name,
          status: row.status,
          trigger: row.trigger,
          mode: row.mode,
          attemptCount: row.attempt_count,
          maxAttempts: row.max_attempts,
          scheduledFor: row.scheduled_for,
          nextAttemptAt: row.next_attempt_at,
          startedAt: row.started_at,
          finishedAt: row.finished_at,
          lastError: row.last_error,
          updatedAt: row.updated_at,
          queue: row.queue_name,
          priority: row.priority,
          delayed: row.delayed,
        },
      });
    }
    // A full batch means more changes are waiting: continue strictly after the last row
    // (keyset on updated_at, id, because a bulk insert gives many rows the same updated_at).
    const last = rows[rows.length - 1];
    if (rows.length === BATCH_LIMIT && last) {
      this.catchUp = { at: last.updated_at, id: last.id };
    } else {
      this.catchUp = undefined;
      this.since = now;
    }

    if (this.seenExecutions.size > SEEN_MAX || nowMs - this.lastPrune > 60_000) {
      this.lastPrune = nowMs;
      for (const [id, entry] of this.seenExecutions) if (nowMs - entry.seenAt > SEEN_TTL_MS) this.seenExecutions.delete(id);
    }
  }

  private async pollAgents(projectIds: string[]): Promise<void> {
    const rows = await this.prisma.agent.findMany({
      where: { projectId: { in: projectIds } },
      select: { id: true, projectId: true, instanceId: true, hostname: true, sdkVersion: true, status: true, handlers: true, connectedAt: true, lastHeartbeatAt: true, disconnectedAt: true },
    });
    const byProject = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byProject.get(row.projectId) ?? [];
      list.push(row);
      byProject.set(row.projectId, list);
    }
    for (const projectId of projectIds) {
      const known = this.agentStatus.get(projectId);
      const current = new Map((byProject.get(projectId) ?? []).map((agent) => [agent.id, agent]));
      if (known) {
        for (const [id, agent] of current) {
          if (known.get(id) !== agent.status) this.emit(projectId, { type: 'agent.updated', data: { ...agent } });
        }
        for (const id of known.keys()) {
          if (!current.has(id)) this.emit(projectId, { type: 'agent.updated', data: { id, projectId, status: 'REMOVED' } });
        }
      }
      this.agentStatus.set(projectId, new Map([...current].map(([id, agent]) => [id, agent.status])));
    }
  }

  private anyWantsWorkers(): boolean {
    for (const set of this.subscribers.values()) for (const subscriber of set) if (subscriber.includeWorkers) return true;
    return false;
  }

  private async pollWorkers(): Promise<void> {
    const rows = await this.prisma.worker.findMany({
      select: { id: true, instanceId: true, hostname: true, version: true, status: true, concurrency: true, startedAt: true, lastHeartbeatAt: true, stoppedAt: true },
    });
    const known = this.workerStatus;
    if (known) {
      for (const worker of rows) {
        if (known.get(worker.id) !== worker.status) this.broadcastWorkers({ type: 'worker.updated', data: { ...worker } });
      }
    }
    this.workerStatus = new Map(rows.map((worker) => [worker.id, worker.status]));
  }

  private emit(projectId: string, event: DashboardEvent): void {
    for (const subscriber of this.subscribers.get(projectId) ?? []) subscriber.send(event);
  }

  private broadcastWorkers(event: DashboardEvent): void {
    for (const set of this.subscribers.values()) for (const subscriber of set) if (subscriber.includeWorkers) subscriber.send(event);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    for (const set of [...this.subscribers.values()]) for (const subscriber of [...set]) subscriber.close('server shutting down');
    this.subscribers.clear();
    this.idle();
  }
}
