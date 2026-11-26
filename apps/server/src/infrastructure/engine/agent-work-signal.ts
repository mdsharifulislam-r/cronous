import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { agentWorkChannel, dispatchWakeChannel } from '@chronos/engine';
import { RedisService } from '../redis/redis.service';

type Listener = (message: string) => void;

/**
 * Cross-replica signals over Redis pub/sub. Signals are hints, never the source of
 * truth: agent work is also found by polling PostgreSQL, and cancelled executions are
 * also detected through failed lease renewals. A lost message (Redis restarting, a
 * subscriber reconnecting) only delays an effect, it never loses one.
 */
@Injectable()
export class SignalBus implements OnApplicationShutdown {
  private readonly logger = new Logger(SignalBus.name);
  private subscriber?: Redis;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(private readonly redis: RedisService) {}

  get keyspace() {
    return this.redis.keyspace;
  }

  async publish(channel: string, message: string): Promise<void> {
    await this.redis.client.publish(channel, message);
  }

  subscribe(channel: string, listener: Listener): () => void {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
      this.connection()
        .subscribe(channel)
        .catch((error: unknown) => this.logger.warn(`Subscribe to ${channel} failed: ${String(error)}`));
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(channel);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(channel);
        this.subscriber?.unsubscribe(channel).catch(() => undefined);
      }
    };
  }

  private connection(): Redis {
    if (!this.subscriber) {
      // ioredis re-subscribes automatically after reconnecting.
      this.subscriber = this.redis.createConnection('subscriber');
      this.subscriber.on('message', (channel: string, message: string) => {
        for (const listener of this.listeners.get(channel) ?? []) {
          try {
            listener(message);
          } catch (error) {
            this.logger.error(`Signal listener for ${channel} threw: ${String(error)}`);
          }
        }
      });
    }
    return this.subscriber;
  }

  onApplicationShutdown(): void {
    this.listeners.clear(); // the connection itself is closed by RedisService
  }
}

/** Wakes the replica(s) holding agents of a project when agent work is queued. */
@Injectable()
export class AgentWorkSignal {
  constructor(private readonly bus: SignalBus) {}

  async publish(projectIds: string[]): Promise<void> {
    await Promise.all(projectIds.map((projectId) => this.bus.publish(agentWorkChannel(this.bus.keyspace, projectId), '1')));
  }

  subscribe(projectId: string, listener: () => void): () => void {
    return this.bus.subscribe(agentWorkChannel(this.bus.keyspace, projectId), () => listener());
  }
}

/**
 * Asks every scheduler runtime (embedded or standalone) to dispatch now, because a
 * submission became due. Lost messages only cost up to one scheduler tick of latency.
 */
@Injectable()
export class DispatchWakeSignal {
  constructor(private readonly bus: SignalBus) {}

  async publish(): Promise<void> {
    await this.bus.publish(dispatchWakeChannel(this.bus.keyspace), '1');
  }

  subscribe(listener: () => void): () => void {
    return this.bus.subscribe(dispatchWakeChannel(this.bus.keyspace), () => listener());
  }
}

export interface CancelNotice {
  executionId: string;
  attempt: number;
  owner: string;
}

/** Tells the replica holding a running execution's executor that it was cancelled. */
@Injectable()
export class CancelSignal {
  constructor(private readonly bus: SignalBus) {}

  private get channel(): string {
    return this.bus.keyspace.key('execution-cancel');
  }

  async publish(notice: CancelNotice): Promise<void> {
    await this.bus.publish(this.channel, JSON.stringify(notice));
  }

  subscribe(listener: (notice: CancelNotice) => void): () => void {
    return this.bus.subscribe(this.channel, (message) => {
      try {
        listener(JSON.parse(message) as CancelNotice);
      } catch {
        // ignore malformed messages
      }
    });
  }
}
