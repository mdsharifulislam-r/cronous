import { describe, expect, it } from 'vitest';
import { executionKind, executionStatusView, jobStatus, jobType } from './status';

describe('status vocabulary', () => {
  it('shows delayed pending executions as Delayed', () => {
    expect(executionStatusView({ status: 'PENDING', delayed: true }).label).toBe('Delayed');
    expect(executionStatusView({ status: 'PENDING', delayed: false }).label).toBe('Waiting');
    expect(executionStatusView({ status: 'RUNNING' }).label).toBe('Active');
  });

  it('distinguishes scheduled, manual, immediate and delayed executions', () => {
    const base = { scheduledFor: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' };
    expect(executionKind({ ...base, trigger: 'SCHEDULE' }).label).toBe('Scheduled');
    expect(executionKind({ ...base, trigger: 'MANUAL' }).label).toBe('Manual');
    expect(executionKind({ ...base, trigger: 'QUEUE' }).label).toBe('Immediate');
    expect(executionKind({ ...base, scheduledFor: '2026-01-01T00:05:00.000Z', trigger: 'QUEUE' }).label).toBe('Delayed');
  });

  it('derives job type and status from the schedule', () => {
    const schedule = { type: 'CRON' as const, state: 'ACTIVE' as const };
    expect(jobType({ schedule: null }).label).toBe('On demand');
    expect(jobType({ schedule: schedule as never }).label).toBe('Cron');
    expect(jobStatus({ enabled: false, schedule: null }).label).toBe('Disabled');
    expect(jobStatus({ enabled: true, schedule: { ...schedule, state: 'PAUSED' } as never }).label).toBe('Paused');
  });
});
