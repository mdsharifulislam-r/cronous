import { describe, expect, it } from 'vitest';
import { Keyspace } from '@chronos/shared';
import { agentWorkChannel, bullJobId, leaseOwnerOf, scheduleSpecFrom, sleep, truncate } from './index';

describe('engine helpers', () => {
  it('gives every attempt its own BullMQ job id', () => {
    expect(bullJobId('abc', 1)).toBe('abc-1');
    expect(bullJobId('abc', 2)).not.toBe(bullJobId('abc', 1));
  });

  it('derives lease owners per executor kind', () => {
    expect(leaseOwnerOf({ kind: 'worker', workerId: 'w1' })).toBe('worker:w1');
    expect(leaseOwnerOf({ kind: 'agent', agentId: 'a1' })).toBe('agent:a1');
  });

  it('namespaces the agent wake-up channel', () => {
    expect(agentWorkChannel(new Keyspace('chronos'), 'p1')).toBe('chronos:agent-work:p1');
  });

  it('maps schedule definitions, defaulting the time zone to the project', () => {
    const spec = scheduleSpecFrom({ cron: '0 2 * * *', misfirePolicy: 'SKIP', misfireGraceMs: 0, maxCatchUp: 1 }, 'Asia/Dhaka');
    expect(spec).toMatchObject({ type: 'CRON', cronExpression: '0 2 * * *', runAt: null, timezone: 'Asia/Dhaka' });
    const once = scheduleSpecFrom(
      { runAt: new Date('2027-01-01T00:00:00Z'), timezone: 'UTC', misfirePolicy: 'FIRE_ONCE', misfireGraceMs: 0, maxCatchUp: 1 },
      'Asia/Dhaka',
    );
    expect(once).toMatchObject({ type: 'ONCE', cronExpression: null, timezone: 'UTC' });
  });

  it('truncates long text and sleeps abortably', async () => {
    expect(truncate('abc', 10)).toBe('abc');
    expect(truncate('x'.repeat(100), 40).length).toBeLessThanOrEqual(40);
    const controller = new AbortController();
    const started = Date.now();
    const pending = sleep(10_000, controller.signal);
    controller.abort();
    await pending;
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
