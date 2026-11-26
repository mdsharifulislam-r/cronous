import { Inject, Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ExecutionQueues, SchedulerRuntime } from '@chronos/engine';
import { APP_CONFIG } from '../../config/config.module';
import { ServerEnv } from '../../config/env.schema';
import { PrismaService } from '../prisma/prisma.service';
import { AgentWorkSignal, DispatchWakeSignal } from './agent-work-signal';
import { nestEngineLogger } from './engine-logger';

/** Runs the scheduler/dispatcher/reaper loop inside the server when enabled. */
@Injectable()
export class SchedulerHost implements OnApplicationBootstrap, OnModuleDestroy {
  readonly runtime: SchedulerRuntime;

  constructor(
    prisma: PrismaService,
    queues: ExecutionQueues,
    signal: AgentWorkSignal,
    private readonly wakeSignal: DispatchWakeSignal,
    @Inject(APP_CONFIG) private readonly config: ServerEnv,
  ) {
    this.runtime = new SchedulerRuntime(
      { prisma, queues, notifyAgents: (ids) => signal.publish(ids), logger: nestEngineLogger('Scheduler') },
      {
        tickMs: config.CHRONOS_SCHEDULER_TICK_MS,
        batchSize: 100,
        reapIntervalMs: 5000,
        queuedStaleMs: 60_000,
        reaper: {
          timeoutGraceMs: 30_000,
          agentStaleMs: config.CHRONOS_AGENT_HEARTBEAT_MS * 4,
          workerStaleMs: 60_000,
          retentionDays: config.CHRONOS_EXECUTION_RETENTION_DAYS,
          batchSize: 100,
        },
      },
    );
  }

  private unsubscribeWake?: () => void;

  onApplicationBootstrap(): void {
    if (!this.config.CHRONOS_EMBEDDED_SCHEDULER) return;
    this.runtime.start();
    this.unsubscribeWake = this.wakeSignal.subscribe(() => this.runtime.wake());
  }

  // onModuleDestroy runs before beforeApplicationShutdown, where the queues are closed.
  async onModuleDestroy(): Promise<void> {
    this.unsubscribeWake?.();
    await this.runtime.stop();
  }
}
