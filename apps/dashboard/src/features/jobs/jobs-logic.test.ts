import { describe, expect, it } from 'vitest';
import type { Job } from '@/types/api';
import { executionCapabilities } from '../executions/execution-row-actions';
import { jobCapabilities } from './job-actions-menu';
import { filterJobs } from './jobs-page';

function job(patch: Partial<Job>): Job {
  return {
    id: patch.name ?? 'x', projectId: 'p', name: 'x', description: null, mode: 'WORKER', source: 'API', enabled: true, queueId: 'q', queue: 'default', priority: null, maxConcurrency: null,
    payloadSchema: null, http: null, payload: null, timeoutMs: 1, maxAttempts: 1, retryBackoffMs: 0, retryBackoffMaxMs: 0, concurrencyPolicy: 'ALLOW', createdAt: '2026-01-10T00:00:00Z', updatedAt: '', schedule: null, lastExecution: null,
    ...patch,
  };
}
const cron = (state: 'ACTIVE' | 'PAUSED', nextRunAt: string | null) => ({ type: 'CRON' as const, cron: '* * * * *', runAt: null, timezone: 'UTC', state, misfirePolicy: 'FIRE_ONCE' as const, misfireGraceMs: 0, maxCatchUp: 1, nextRunAt, lastScheduledAt: null, version: 1 });

describe('job list filtering and sorting', () => {
  const jobs = [
    job({ name: 'b-cron', schedule: cron('ACTIVE', '2026-02-01T00:00:00Z') }),
    job({ name: 'a-paused', schedule: cron('PAUSED', null) }),
    job({ name: 'c-ondemand', createdAt: '2026-03-01T00:00:00Z' }),
    job({ name: 'd-disabled', enabled: false }),
  ];
  const all = { type: 'all', status: 'all', createdFrom: '', createdTo: '' };

  it('filters by type, status and creation date', () => {
    expect(filterJobs(jobs, { ...all, type: 'Cron' }, { key: 'name', dir: 'asc' }).map((j) => j.name)).toEqual(['a-paused', 'b-cron']);
    expect(filterJobs(jobs, { ...all, status: 'Paused' }, { key: 'name', dir: 'asc' }).map((j) => j.name)).toEqual(['a-paused']);
    expect(filterJobs(jobs, { ...all, status: 'Disabled' }, { key: 'name', dir: 'asc' }).map((j) => j.name)).toEqual(['d-disabled']);
    expect(filterJobs(jobs, { ...all, createdFrom: '2026-02-15' }, { key: 'name', dir: 'asc' }).map((j) => j.name)).toEqual(['c-ondemand']);
  });

  it('sorts with missing values last', () => {
    expect(filterJobs(jobs, all, { key: 'next', dir: 'asc' })[0]?.name).toBe('b-cron');
    expect(filterJobs(jobs, all, { key: 'name', dir: 'desc' }).map((j) => j.name)).toEqual(['d-disabled', 'c-ondemand', 'b-cron', 'a-paused']);
  });
});

describe('action rules', () => {
  it('offers only valid job actions for the state and role', () => {
    const active = jobCapabilities(job({ schedule: cron('ACTIVE', null) }), true);
    expect(active).toMatchObject({ pause: true, resume: false, trigger: true });
    expect(jobCapabilities(job({ schedule: cron('PAUSED', null) }), true)).toMatchObject({ pause: false, resume: true });
    expect(jobCapabilities(job({ enabled: false }), true)).toMatchObject({ trigger: false, submit: false });
    expect(jobCapabilities(job({ lastExecution: { id: 'e', status: 'DEAD_LETTERED', trigger: 'QUEUE', createdAt: '', finishedAt: null } }), true)).toMatchObject({ retryLast: true, cancelLast: false });
    expect(jobCapabilities(job({ lastExecution: { id: 'e', status: 'QUEUED', trigger: 'QUEUE', createdAt: '', finishedAt: null } }), true)).toMatchObject({ retryLast: false, cancelLast: true });
    expect(Object.values(jobCapabilities(job({ schedule: cron('ACTIVE', null) }), false)).every((allowed) => !allowed)).toBe(true);
  });

  it('allows cancel only before completion and retry only after failure', () => {
    expect(executionCapabilities('RUNNING', true)).toEqual({ cancel: true, retry: false });
    expect(executionCapabilities('FAILED', true)).toEqual({ cancel: false, retry: true });
    expect(executionCapabilities('SUCCEEDED', true)).toEqual({ cancel: false, retry: false });
    expect(executionCapabilities('PENDING', false)).toEqual({ cancel: false, retry: false });
  });
});
