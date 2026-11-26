import { describe, expect, it } from 'vitest';
import { agentTaskDefinitionSchema, clientMessageSchema, scheduleDefinitionSchema, serverMessageSchema } from './index';

describe('definitions', () => {
  it('applies defaults to agent task definitions', () => {
    const parsed = agentTaskDefinitionSchema.parse({ name: 'daily-report', schedule: { cron: '0 2 * * *', timezone: 'Asia/Dhaka' } });
    expect(parsed).toMatchObject({ maxAttempts: 3, timeoutMs: 300_000, concurrencyPolicy: 'ALLOW' });
    expect(parsed.schedule).toMatchObject({ misfirePolicy: 'FIRE_ONCE', maxCatchUp: 10 });
  });

  it('rejects invalid names, zones, crons and ambiguous schedules', () => {
    expect(agentTaskDefinitionSchema.safeParse({ name: 'bad name' }).success).toBe(false);
    expect(scheduleDefinitionSchema.safeParse({ cron: '0 2 * * *', timezone: 'Mars/Base' }).success).toBe(false);
    expect(scheduleDefinitionSchema.safeParse({ cron: '0 25 * * *' }).success).toBe(false);
    expect(scheduleDefinitionSchema.safeParse({ cron: '0 2 * * *', runAt: '2027-01-01T00:00:00Z' }).success).toBe(false);
    expect(scheduleDefinitionSchema.safeParse({}).success).toBe(false);
    expect(agentTaskDefinitionSchema.safeParse({ name: 'x', retryBackoffMs: 100, retryBackoffMaxMs: 10 }).success).toBe(false);
  });
});

describe('messages', () => {
  it('parses client frames and rejects unknown fields', () => {
    const result = clientMessageSchema.parse({
      type: 'result',
      executionId: '6f9a8b0e-3c0a-4a8a-9a43-1f5a0f3a9d11',
      attempt: 1,
      status: 'failed',
      error: { message: 'boom' },
    });
    expect(result).toMatchObject({ status: 'failed', error: { retryable: true, timedOut: false } });
    expect(clientMessageSchema.safeParse({ type: 'heartbeat', running: [], extra: 1 }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ type: 'nope' }).success).toBe(false);
  });

  it('parses server frames', () => {
    expect(serverMessageSchema.parse({ type: 'error', code: 'X', message: 'y' }).type).toBe('error');
  });
});
