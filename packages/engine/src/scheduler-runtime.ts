import { PrismaClient } from '@chronos/database';
import { EngineLogger, errorMessage, silentLogger, sleep } from './common';
import { Dispatcher } from './dispatcher';
import { ExecutionStore } from './executions';
import { ExecutionQueues } from './queues';
import { DEFAULT_REAPER_OPTIONS, Reaper, ReaperOptions } from './reaper';
import { SchedulerEngine } from './scheduler';

export interface SchedulerRuntimeOptions {
  tickMs: number;
  batchSize: number;
  reapIntervalMs: number;
  queuedStaleMs: number;
  reaper: ReaperOptions;
}

export const DEFAULT_SCHEDULER_RUNTIME_OPTIONS: SchedulerRuntimeOptions = {
  tickMs: 1000,
  batchSize: 100,
  reapIntervalMs: 5000,
  queuedStaleMs: 60_000,
  reaper: DEFAULT_REAPER_OPTIONS,
};

export interface SchedulerRuntimeDeps {
  prisma: PrismaClient;
  queues: ExecutionQueues;
  notifyAgents: (projectIds: string[]) => Promise<void>;
  logger?: EngineLogger;
}

/**
 * Drives scheduling, dispatch and recovery in one loop. Any number of instances (inside
 * server replicas or standalone scheduler processes) may run at once.
 */
export class SchedulerRuntime {
  readonly scheduler: SchedulerEngine;
  readonly dispatcher: Dispatcher;
  readonly reaper: Reaper;
  private readonly logger: EngineLogger;
  private abort?: AbortController;
  private loop?: Promise<void>;
  private lastReap = 0;
  private consecutiveErrors = 0;
  private wakeRequested = false;
  private wakeSleeper?: () => void;
  /** Timestamp of the last completed loop iteration; used for health reporting. */
  lastCycleAt: number | null = null;

  constructor(
    deps: SchedulerRuntimeDeps,
    private readonly options: SchedulerRuntimeOptions = DEFAULT_SCHEDULER_RUNTIME_OPTIONS,
  ) {
    this.logger = deps.logger ?? silentLogger;
    this.scheduler = new SchedulerEngine(deps.prisma, { batchSize: options.batchSize }, this.logger);
    this.dispatcher = new Dispatcher(
      { prisma: deps.prisma, queues: deps.queues, notifyAgents: deps.notifyAgents, logger: this.logger },
      { batchSize: options.batchSize * 2, queuedStaleMs: options.queuedStaleMs },
    );
    this.reaper = new Reaper(deps.prisma, new ExecutionStore(deps.prisma), options.reaper, this.logger);
  }

  get running(): boolean {
    return this.loop !== undefined;
  }

  start(): void {
    if (this.loop) return;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.loop = (async () => {
      while (!signal.aborted) {
        this.wakeRequested = false;
        await this.cycle();
        // A wake-up that arrived during the cycle (new submission) runs the next one now.
        if (this.wakeRequested && this.consecutiveErrors === 0) continue;
        // Back off up to 30s while the database is unavailable instead of spinning.
        const delay = this.consecutiveErrors === 0 ? this.options.tickMs : Math.min(30_000, this.options.tickMs * 2 ** this.consecutiveErrors);
        await Promise.race([sleep(delay, signal), new Promise<void>((resolve) => (this.wakeSleeper = resolve))]);
        this.wakeSleeper = undefined;
      }
    })();
    this.logger.info('Scheduler runtime started', { tickMs: this.options.tickMs });
  }

  /**
   * Requests a cycle as soon as possible (a submission became due now). A hint only:
   * without it the next tick dispatches the work anyway.
   */
  wake(): void {
    if (!this.loop) return;
    this.wakeRequested = true;
    this.wakeSleeper?.();
  }

  /** Runs one full cycle. Exposed for tests and for a deterministic single step. */
  async cycle(): Promise<void> {
    try {
      const tick = await this.scheduler.tickUntilDrained();
      if (tick.executionsCreated > 0 || tick.occurrencesDropped > 0 || tick.skippedForOverlap > 0) {
        this.logger.info('Scheduled executions', { ...tick });
      }
      await this.dispatcher.dispatchUntilDrained();
      if (Date.now() - this.lastReap >= this.options.reapIntervalMs) {
        this.lastReap = Date.now();
        await this.reaper.reapOnce();
        await this.dispatcher.sweepStale();
      }
      this.consecutiveErrors = 0;
      this.lastCycleAt = Date.now();
    } catch (error) {
      this.consecutiveErrors += 1;
      this.logger.error('Scheduler cycle failed', { error: errorMessage(error), consecutiveErrors: this.consecutiveErrors });
    }
  }

  /** Stops after the current cycle finishes (never interrupts a transaction). */
  async stop(): Promise<void> {
    if (!this.loop) return;
    this.abort?.abort();
    await this.loop;
    this.loop = undefined;
    this.logger.info('Scheduler runtime stopped');
  }
}
