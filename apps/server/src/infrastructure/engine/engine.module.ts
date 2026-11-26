import { Global, Module } from '@nestjs/common';
import { ExecutionQueues, ExecutionStore } from '@chronos/engine';
import { PrismaService } from '../prisma/prisma.service';
import { QueueFactory } from '../redis/queue.factory';
import { AgentWorkSignal, CancelSignal, DispatchWakeSignal, SignalBus } from './agent-work-signal';
import { SchedulerHost } from './scheduler-host';
import { WorkerHost } from './worker-host';

@Global()
@Module({
  providers: [
    { provide: ExecutionStore, useFactory: (prisma: PrismaService) => new ExecutionStore(prisma), inject: [PrismaService] },
    {
      provide: ExecutionQueues,
      useFactory: (factory: QueueFactory) => new ExecutionQueues((name) => factory.getQueue(name)),
      inject: [QueueFactory],
    },
    SignalBus,
    AgentWorkSignal,
    CancelSignal,
    DispatchWakeSignal,
    SchedulerHost,
    WorkerHost,
  ],
  exports: [ExecutionStore, ExecutionQueues, SignalBus, AgentWorkSignal, CancelSignal, DispatchWakeSignal, SchedulerHost, WorkerHost],
})
export class EngineModule {}
