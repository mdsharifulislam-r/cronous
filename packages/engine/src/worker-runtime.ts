import { randomUUID } from 'node:crypto';
import { hostname as osHostname } from 'node:os';
import { Job, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { Prisma, PrismaClient } from '@chronos/database';
import type { Keyspace } from '@chronos/shared';
import { EngineLogger, errorMessage, silentLogger } from './common';
import { ClaimedExecution, ExecutionStore, FailureReport, SuccessReport } from './executions';
import { ExecutionOutcome, HttpExecutor } from './http/http-executor';
import { EXECUTION_QUEUES, ExecutionJobData, QueuedMode } from './queues';

export interface WorkerTaskContext<TPayload = unknown> {
  executionId: string;
  attempt: number;
  job: string;
  scheduledFor: Date;
  idempotencyKey: string;
  payload: TPayload;
  signal: AbortSignal;
  log: (level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR', message: string, data?: unknown) => Promise<void>;
}

/** Mode C handler. Throw `PermanentError` (or set `retryable = false`) to skip retries. */
export type WorkerHandler = (context: WorkerTaskContext) => unknown;

export class PermanentError extends Error {
  readonly retryable = false;
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'PermanentError';
  }
}

export interface WorkerRuntimeOptions {
  modes: QueuedMode[];
  concurrency: number;
  leaseMs: number;
  heartbeatMs: number;
  version: string;
  instanceId?: string;
  hostname?: string;
}

export interface WorkerRuntimeDeps {
  prisma: PrismaClient;
  keyspace: Keyspace;
  /** Opens a Redis connection suitable for BullMQ workers (maxRetriesPerRequest: null). */
  workerConnection: () => Redis;
  http: HttpExecutor;
  handlers?: Record<string, WorkerHandler>;
  logger?: EngineLogger;
}

/**
 * A central executor (Mode C, and HTTP webhooks for Mode A). Consumes BullMQ deliveries,
 * but correctness comes from PostgreSQL: every delivery is claimed with a conditional
 * update, the lease is renewed while running, and results are fenced on lease owner and
 * attempt number. A crashed worker's executions are recovered by the reaper.
 */
export class WorkerRuntime {
  readonly instanceId: string;
  workerId?: string;
  private readonly store: ExecutionStore;
  private readonly logger: EngineLogger;
  private readonly bullWorkers: Worker[] = [];
  private heartbeatTimer?: NodeJS.Timeout;
  private stopping = false;
  /** The heartbeat write in flight, awaited by stop() so OFFLINE is always the last write. */
  private heartbeatWrite: Promise<unknown> = Promise.resolve();
  private readonly active = new Map<string, AbortController>();

  constructor(
    private readonly deps: WorkerRuntimeDeps,
    private readonly options: WorkerRuntimeOptions,
  ) {
    this.instanceId = options.instanceId ?? randomUUID();
    this.store = new ExecutionStore(deps.prisma);
    this.logger = deps.logger ?? silentLogger;
  }

  get activeCount(): number {
    return this.active.size;
  }

  async start(): Promise<void> {
    const worker = await this.deps.prisma.worker.upsert({
      where: { instanceId: this.instanceId },
      create: {
        instanceId: this.instanceId,
        hostname: this.options.hostname ?? osHostname(),
        version: this.options.version,
        concurrency: this.options.concurrency,
        status: 'ONLINE',
      },
      update: { status: 'ONLINE', stoppedAt: null, lastHeartbeatAt: new Date(), concurrency: this.options.concurrency },
    });
    this.workerId = worker.id;

    for (const mode of this.options.modes) {
      const bullWorker = new Worker<ExecutionJobData>(EXECUTION_QUEUES[mode], (job) => this.process(job), {
        prefix: this.deps.keyspace.bullPrefix,
        connection: this.deps.workerConnection(),
        concurrency: this.options.concurrency,
        // Long jobs are protected by our own lease, not BullMQ's lock.
        lockDuration: Math.max(30_000, this.options.leaseMs),
      });
      bullWorker.on('error', (error: Error) => this.logger.error('BullMQ worker error', { queue: EXECUTION_QUEUES[mode], error: error.message }));
      this.bullWorkers.push(bullWorker);
    }

    this.heartbeatTimer = setInterval(() => {
      if (this.stopping) return;
      this.heartbeatWrite = this.deps.prisma.worker
        .update({ where: { id: this.workerId! }, data: { lastHeartbeatAt: new Date(), status: 'ONLINE' } })
        .catch((error: unknown) => this.logger.warn('Worker heartbeat failed', { error: errorMessage(error) }));
    }, this.options.heartbeatMs);
    this.heartbeatTimer.unref();
    this.logger.info('Worker started', { workerId: this.workerId, modes: this.options.modes, concurrency: this.options.concurrency });
  }

  /** Processes one delivery. Never throws for handler failures: those are recorded in PostgreSQL. */
  async process(job: Job<ExecutionJobData>): Promise<'completed' | 'skipped'> {
    const claimed = await this.store.claim(job.data.executionId, { kind: 'worker', workerId: this.workerId! }, this.options.leaseMs);
    if (!claimed) return 'skipped'; // duplicate delivery, cancelled, or already handled
    const ref = { executionId: claimed.executionId, attempt: claimed.attempt, owner: claimed.owner };

    const controller = new AbortController();
    this.active.set(claimed.executionId, controller);
    const timeout = setTimeout(
      () => controller.abort(Object.assign(new Error(`Execution exceeded its timeout of ${claimed.timeoutMs}ms`), { name: 'TimeoutError' })),
      claimed.timeoutMs,
    );
    const renew = setInterval(() => {
      this.store
        .renewLease(ref, this.options.leaseMs)
        .then((held) => {
          if (!held) controller.abort(Object.assign(new Error('Execution was cancelled or reassigned'), { name: 'LeaseLostError' }));
        })
        .catch((error: unknown) => this.logger.warn('Lease renewal failed', { executionId: ref.executionId, error: errorMessage(error) }));
    }, Math.max(1000, Math.floor(this.options.leaseMs / 3)));

    try {
      const outcome = await this.run(claimed, controller.signal);
      if (controller.signal.aborted && (controller.signal.reason as Error)?.name === 'LeaseLostError') return 'skipped';
      if (outcome.ok) await this.store.complete(ref, outcome.report);
      else await this.store.fail(ref, outcome.report);
      return 'completed';
    } finally {
      clearTimeout(timeout);
      clearInterval(renew);
      this.active.delete(claimed.executionId);
    }
  }

  private async run(execution: ClaimedExecution, signal: AbortSignal): Promise<ExecutionOutcome> {
    if (execution.mode === 'HTTP') return this.deps.http.execute(execution, signal);

    const handler = this.deps.handlers?.[execution.jobName];
    if (!handler) {
      return { ok: false, report: { message: `No worker handler registered for job "${execution.jobName}"`, code: 'NO_HANDLER', retryable: true } };
    }
    const ref = { executionId: execution.executionId, attempt: execution.attempt, owner: execution.owner };
    const context: WorkerTaskContext = {
      executionId: execution.executionId,
      attempt: execution.attempt,
      job: execution.jobName,
      scheduledFor: execution.scheduledFor,
      idempotencyKey: execution.idempotencyKey,
      payload: execution.payload,
      signal,
      log: async (level, message, data) => {
        await this.store.appendLog(ref, level, message, data === undefined ? undefined : (JSON.parse(JSON.stringify(data)) as Prisma.InputJsonValue));
      },
    };
    const aborted = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    try {
      const output = await Promise.race([Promise.resolve().then(() => handler(context)), aborted]);
      const report: SuccessReport = output === undefined ? {} : { output: JSON.parse(JSON.stringify(output)) as Prisma.InputJsonValue };
      return { ok: true, report };
    } catch (error) {
      const timedOut = signal.aborted && (signal.reason as Error)?.name === 'TimeoutError';
      const failure: FailureReport = {
        message: errorMessage(timedOut ? signal.reason : error),
        retryable: (error as { retryable?: boolean })?.retryable !== false,
        timedOut,
        ...(timedOut ? { code: 'TIMEOUT' } : (error as { code?: string })?.code ? { code: String((error as { code: string }).code) } : {}),
      };
      return { ok: false, report: failure };
    }
  }

  /**
   * Graceful shutdown: stop taking deliveries and wait for running executions (BullMQ's
   * close waits for active jobs). If the process is killed first, leases expire and the
   * reaper retries those executions elsewhere.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await Promise.allSettled(this.bullWorkers.map((worker) => worker.close()));
    this.bullWorkers.length = 0;
    // A heartbeat that started before stop() must not land after (and undo) the OFFLINE write.
    await this.heartbeatWrite;
    if (this.workerId) {
      await this.deps.prisma.worker
        .update({ where: { id: this.workerId }, data: { status: 'OFFLINE', stoppedAt: new Date() } })
        .catch(() => undefined);
    }
    this.logger.info('Worker stopped', { workerId: this.workerId });
  }
}
