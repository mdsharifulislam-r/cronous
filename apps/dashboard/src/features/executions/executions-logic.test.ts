import { describe, expect, it } from 'vitest';
import type { ExecutionDetail } from '@/types/api';
import { buildTimeline } from './execution-timeline';
import { filtersFromParams } from './executions-page';

describe('execution filters from the URL', () => {
  it('parses valid filters and ignores invalid ones', () => {
    const filters = filtersFromParams(new URLSearchParams('status=FAILED,DEAD_LETTERED,BOGUS&trigger=QUEUE&mode=AGENT&queue=emails&jobId=not-a-uuid&workerId=11111111-1111-4111-8111-111111111111&from=2026-11-01&to=nope'));
    expect(filters).toEqual({
      status: ['FAILED', 'DEAD_LETTERED'],
      trigger: 'QUEUE',
      mode: 'AGENT',
      queue: 'emails',
      workerId: '11111111-1111-4111-8111-111111111111',
      from: new Date('2026-11-01T00:00:00').toISOString(),
    });
    expect(filtersFromParams(new URLSearchParams('delayed=true&queue=Bad Queue'))).toEqual({ delayed: true });
    expect(filtersFromParams(new URLSearchParams(''))).toEqual({});
  });
});

describe('execution timeline', () => {
  const base: ExecutionDetail = {
    id: 'e', jobId: 'j', jobName: 'mail', queue: 'emails', priority: 70, delayed: false, trigger: 'QUEUE', status: 'SUCCEEDED', mode: 'AGENT',
    scheduledFor: '2026-01-01T00:05:00.000Z', idempotencyKey: 'k', attemptCount: 2, maxAttempts: 3, nextAttemptAt: null,
    startedAt: '2026-01-01T00:05:01.000Z', finishedAt: '2026-01-01T00:05:20.000Z', lastError: null, createdAt: '2026-01-01T00:00:00.000Z',
    projectId: 'p', payload: null, timeoutMs: 1000, retryBackoffMs: 1000, retryBackoffMaxMs: 2000, leaseOwner: null, leaseExpiresAt: null, result: { ok: true }, updatedAt: '', logs: [], logsTruncated: false,
    attempts: [
      { id: 'a2', attemptNumber: 2, status: 'SUCCEEDED', agentId: 'g', workerId: null, agent: { id: 'g', hostname: 'api-1', instanceId: 'i' }, worker: null, startedAt: '2026-01-01T00:05:15.000Z', finishedAt: '2026-01-01T00:05:20.000Z', leaseExpiresAt: null, errorCode: null, errorMessage: null, httpStatus: null, output: null },
      { id: 'a1', attemptNumber: 1, status: 'TIMED_OUT', agentId: 'g', workerId: null, agent: { id: 'g', hostname: 'api-1', instanceId: 'i' }, worker: null, startedAt: '2026-01-01T00:05:01.000Z', finishedAt: '2026-01-01T00:05:11.000Z', leaseExpiresAt: null, errorCode: 'TIMEOUT', errorMessage: 'took too long', httpStatus: null, output: null },
    ],
  };

  it('orders submission, delay, attempts, retry and completion', () => {
    const titles = buildTimeline(base).map((event) => event.title);
    expect(titles).toEqual(['Submitted (delayed)', 'Due', 'Attempt 1 started', 'Attempt 1 timed out', 'Retry scheduled', 'Attempt 2 started', 'Attempt 2 succeeded', 'Completed']);
    const failure = buildTimeline(base).find((event) => event.title === 'Attempt 1 timed out');
    expect(failure).toMatchObject({ tone: 'warning', detail: 'TIMEOUT · took too long' });
  });

  it('shows the scheduled next attempt while retrying', () => {
    const retrying = { ...base, status: 'RETRY_SCHEDULED' as const, finishedAt: null, attemptCount: 1, nextAttemptAt: '2026-01-01T00:06:00.000Z', attempts: [base.attempts[1]!] };
    expect(buildTimeline(retrying).at(-1)?.title).toBe('Attempt 2 scheduled');
  });
});
