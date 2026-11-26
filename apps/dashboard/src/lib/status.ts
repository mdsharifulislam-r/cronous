import type { AttemptStatus, ExecutionStatus, ExecutionTrigger, ExecutorStatus, Job } from '@/types/api';

/**
 * One status vocabulary for the whole UI. API statuses are mapped to labels and tones so
 * the same state looks the same on every page.
 */
export type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'delayed';

export interface StatusView {
  label: string;
  tone: Tone;
  description: string;
}

export const EXECUTION_STATUS: Record<ExecutionStatus, StatusView> = {
  PENDING: { label: 'Waiting', tone: 'neutral', description: 'Stored, waiting to be admitted to its queue' },
  QUEUED: { label: 'Queued', tone: 'info', description: 'Admitted, waiting for an executor to pick it up' },
  RUNNING: { label: 'Active', tone: 'primary', description: 'An executor is running it' },
  RETRY_SCHEDULED: { label: 'Retrying', tone: 'warning', description: 'An attempt failed; the next attempt is scheduled' },
  SUCCEEDED: { label: 'Completed', tone: 'success', description: 'Finished successfully' },
  FAILED: { label: 'Failed', tone: 'danger', description: 'Failed with a non-retryable error' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral', description: 'Cancelled before completion' },
  DEAD_LETTERED: { label: 'Dead-lettered', tone: 'danger', description: 'All attempts failed; can be retried manually' },
};

export const DELAYED_STATUS: StatusView = { label: 'Delayed', tone: 'delayed', description: 'Submitted with a future run time' };

export function executionStatusView(execution: { status: ExecutionStatus; delayed?: boolean }): StatusView {
  return execution.status === 'PENDING' && execution.delayed ? DELAYED_STATUS : EXECUTION_STATUS[execution.status];
}

export const ATTEMPT_STATUS: Record<AttemptStatus, StatusView> = {
  RUNNING: { label: 'Running', tone: 'primary', description: 'Attempt in progress' },
  SUCCEEDED: { label: 'Succeeded', tone: 'success', description: 'Attempt succeeded' },
  FAILED: { label: 'Failed', tone: 'danger', description: 'Attempt failed' },
  TIMED_OUT: { label: 'Timed out', tone: 'warning', description: 'Attempt exceeded its timeout' },
  ABANDONED: { label: 'Abandoned', tone: 'warning', description: 'The executor lost its lease (crash or disconnect)' },
};

export const EXECUTOR_STATUS: Record<ExecutorStatus, StatusView> = {
  ONLINE: { label: 'Connected', tone: 'success', description: 'Heartbeating normally' },
  DRAINING: { label: 'Draining', tone: 'warning', description: 'Shutting down: finishing work, taking no new work' },
  OFFLINE: { label: 'Disconnected', tone: 'neutral', description: 'Not connected' },
};

/** How an execution came to exist. Delayed and immediate submissions are not cron schedules. */
export function executionKind(execution: { trigger: ExecutionTrigger; scheduledFor: string; createdAt: string; delayed?: boolean }): {
  label: 'Scheduled' | 'Manual' | 'Immediate' | 'Delayed';
  tone: Tone;
} {
  if (execution.trigger === 'SCHEDULE') return { label: 'Scheduled', tone: 'info' };
  if (execution.trigger === 'MANUAL') return { label: 'Manual', tone: 'neutral' };
  const delayedBy = new Date(execution.scheduledFor).getTime() - new Date(execution.createdAt).getTime();
  return execution.delayed || delayedBy > 2000 ? { label: 'Delayed', tone: 'delayed' } : { label: 'Immediate', tone: 'primary' };
}

/**
 * A job's type in the dashboard. Chronos jobs are definitions; a schedule makes them run on
 * their own. Jobs without a schedule run when submitted (immediately or delayed) or triggered.
 */
export function jobType(job: Pick<Job, 'schedule'>): { label: 'Cron' | 'One-time' | 'On demand'; tone: Tone } {
  if (!job.schedule) return { label: 'On demand', tone: 'neutral' };
  return job.schedule.type === 'CRON' ? { label: 'Cron', tone: 'info' } : { label: 'One-time', tone: 'delayed' };
}

export function jobStatus(job: Pick<Job, 'enabled' | 'schedule'>): StatusView {
  if (!job.enabled) return { label: 'Disabled', tone: 'neutral', description: 'Never runs (scheduled or submitted) until enabled' };
  if (!job.schedule) return { label: 'Ready', tone: 'success', description: 'Runs when submitted or triggered' };
  if (job.schedule.state === 'PAUSED') return { label: 'Paused', tone: 'warning', description: 'Schedule paused; submissions still run' };
  if (job.schedule.state === 'COMPLETED') return { label: 'Completed', tone: 'neutral', description: 'One-time schedule has run' };
  return { label: 'Scheduled', tone: 'info', description: 'Runs on its schedule' };
}

export const MODE_LABEL = { HTTP: 'HTTP webhook', AGENT: 'Agent', WORKER: 'Central worker' } as const;
