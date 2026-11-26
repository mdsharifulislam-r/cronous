import { describe, expect, it } from 'vitest';
import type { Queue } from '@/types/api';
import { queueFormSchema } from './queue-dialog';
import { queueHealth } from './queues-page';
import { expectedAt, submitSchema, toQueueSubmission, type SubmitValues } from './submit-model';

const values = (patch: Partial<SubmitValues> = {}): SubmitValues => ({
  job: 'send-email', queue: '', payloadText: '', delivery: 'immediate', delayMode: 'duration', delayValue: 5, delayUnit: 'm', runAtLocal: '', timezone: 'UTC',
  priority: '', idempotencyKey: '', maxAttempts: '', backoffValue: '', backoffMaxValue: '', backoffUnit: 's', timeoutValue: '', timeoutUnit: 's', ...patch,
});
const issues = (input: SubmitValues) => {
  const result = submitSchema.safeParse(input);
  return result.success ? {} : Object.fromEntries(result.error.issues.map((issue) => [issue.path.join('.'), issue.message]));
};

describe('queue submission model', () => {
  it('builds an immediate submission with only the fields that were set', () => {
    expect(toQueueSubmission(values())).toEqual({ job: 'send-email' });
    expect(toQueueSubmission(values({ payloadText: '{"to":"a@example.com"}', queue: 'emails', priority: '90', idempotencyKey: 'welcome-7', maxAttempts: '5', backoffValue: '2', backoffMaxValue: '60', timeoutValue: '30' }))).toEqual({
      job: 'send-email', payload: { to: 'a@example.com' }, queue: 'emails', priority: 90, idempotencyKey: 'welcome-7', maxAttempts: 5, retryBackoffMs: 2000, retryBackoffMaxMs: 60_000, timeoutMs: 30_000,
    });
  });

  it('expresses delays as delayMs or an absolute runAt, never as cron', () => {
    expect(toQueueSubmission(values({ delivery: 'delayed', delayValue: 2, delayUnit: 'h' }))).toEqual({ job: 'send-email', delayMs: 7_200_000 });
    expect(toQueueSubmission(values({ delivery: 'delayed', delayMode: 'datetime', runAtLocal: '2099-06-01T08:30', timezone: 'Asia/Dhaka' }))).toEqual({ job: 'send-email', runAt: '2099-06-01T02:30:00.000Z' });
    expect(expectedAt(values({ delivery: 'delayed', delayValue: 10, delayUnit: 'm' }), 0)?.getTime()).toBe(600_000);
    expect(expectedAt(values())).toBeNull();
  });

  it('validates delays, JSON and overrides', () => {
    expect(issues(values({ payloadText: '{bad' })).payloadText).toMatch(/Invalid JSON/);
    expect(issues(values({ delivery: 'delayed', delayValue: 0 })).delayValue).toBeDefined();
    expect(issues(values({ delivery: 'delayed', delayMode: 'datetime', runAtLocal: '2001-01-01T00:00' })).runAtLocal).toMatch(/future/);
    expect(issues(values({ delivery: 'delayed', delayMode: 'datetime', runAtLocal: '2099-01-01T00:00', timezone: 'Nowhere/City' })).timezone).toBeDefined();
    expect(issues(values({ priority: '200' })).priority).toBeDefined();
    expect(issues(values({ backoffValue: '10', backoffMaxValue: '5' })).backoffMaxValue).toBeDefined();
    expect(issues(values({ timeoutValue: '0' })).timeoutValue).toBeDefined();
    expect(issues(values({ idempotencyKey: 'has space' })).idempotencyKey).toBeDefined();
    expect(issues(values({ delivery: 'delayed' }))).toEqual({});
  });
});

describe('queues', () => {
  const queue = (patch: Partial<Queue>): Queue => ({ id: 'q', name: 'emails', description: null, concurrencyLimit: null, defaultPriority: 50, paused: false, createdAt: '', updatedAt: '', jobs: 1, counts: { waiting: 0, delayed: 0, retrying: 0, queued: 0, running: 0 }, ...patch });

  it('derives health from pause, limits and counts', () => {
    expect(queueHealth(queue({ paused: true })).label).toBe('Paused');
    expect(queueHealth(queue({ concurrencyLimit: 2, counts: { waiting: 3, delayed: 0, retrying: 0, queued: 1, running: 1 } })).label).toBe('At limit');
    expect(queueHealth(queue({})).label).toBe('Idle');
    expect(queueHealth(queue({ counts: { waiting: 0, delayed: 1, retrying: 0, queued: 0, running: 0 } })).label).toBe('Active');
  });

  it('validates the queue form like the server', () => {
    expect(queueFormSchema.safeParse({ name: 'emails', description: '', concurrencyLimit: '', defaultPriority: '50' }).success).toBe(true);
    expect(queueFormSchema.safeParse({ name: 'Emails!', description: '', concurrencyLimit: '', defaultPriority: '50' }).success).toBe(false);
    expect(queueFormSchema.safeParse({ name: 'emails', description: '', concurrencyLimit: '0', defaultPriority: '50' }).success).toBe(false);
    expect(queueFormSchema.safeParse({ name: 'emails', description: '', concurrencyLimit: '5', defaultPriority: '101' }).success).toBe(false);
  });
});
