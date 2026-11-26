import { BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';
import { Job, Processor, Queue, QueueOptions, Worker, WorkerOptions } from 'bullmq';
import { RedisService } from './redis.service';

/**
 * Creates BullMQ queues and workers bound to the Chronos namespace and to the
 * correctly configured Redis connections. Everything created here is closed on
 * shutdown, before RedisService closes the underlying connections: workers first
 * (so in-flight jobs finish), then queues.
 */
@Injectable()
export class QueueFactory implements BeforeApplicationShutdown {
  private readonly logger = new Logger(QueueFactory.name);
  private readonly queues = new Map<string, Queue>();
  private readonly workers = new Set<Worker>();

  constructor(private readonly redis: RedisService) {}

  getQueue<TData = unknown>(name: string, options: Omit<QueueOptions, 'connection' | 'prefix'> = {}): Queue<TData> {
    const existing = this.queues.get(name);
    if (existing) return existing as Queue<TData>;
    const queue = new Queue<TData>(name, {
      ...options,
      prefix: this.redis.keyspace.bullPrefix,
      connection: this.redis.createConnection('producer'),
    });
    queue.on('error', (error: Error) => this.logger.error(`Queue "${name}" error: ${error.message}`));
    this.queues.set(name, queue as Queue);
    return queue;
  }

  createWorker<TData = unknown, TResult = unknown>(
    name: string,
    processor: Processor<TData, TResult>,
    options: Omit<WorkerOptions, 'connection' | 'prefix'> = {},
  ): Worker<TData, TResult> {
    const worker = new Worker<TData, TResult>(name, processor, {
      ...options,
      prefix: this.redis.keyspace.bullPrefix,
      connection: this.redis.createConnection('worker'),
    });
    worker.on('error', (error: Error) => this.logger.error(`Worker "${name}" error: ${error.message}`));
    worker.on('failed', (job: Job<TData, TResult> | undefined, error: Error) =>
      this.logger.warn(`Worker "${name}" job ${job?.id ?? '?'} failed: ${error.message}`),
    );
    this.workers.add(worker as Worker);
    return worker;
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.allSettled([...this.workers].map((worker) => worker.close()));
    await Promise.allSettled([...this.queues.values()].map((queue) => queue.close()));
    this.workers.clear();
    this.queues.clear();
  }
}
