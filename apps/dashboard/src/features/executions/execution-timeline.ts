import type { Attempt, ExecutionDetail } from '@/types/api';
import { ATTEMPT_STATUS, executionKind, type Tone } from '@/lib/status';

export interface TimelineEvent {
  key: string;
  at: string;
  title: string;
  detail?: string;
  tone: Tone;
}

/**
 * Builds the visible history of an execution from what the API records: creation
 * (submission or schedule occurrence), its due time, every attempt's start (the claim
 * by an executor) and end, retry waits, and the final outcome. The moment an execution
 * entered QUEUED is not stored separately, so it is not shown.
 */
export function buildTimeline(execution: ExecutionDetail): TimelineEvent[] {
  const kind = executionKind(execution);
  const events: TimelineEvent[] = [
    {
      key: 'created',
      at: execution.createdAt,
      title: kind.label === 'Scheduled' ? 'Created by the schedule' : kind.label === 'Manual' ? 'Triggered manually' : `Submitted (${kind.label.toLowerCase()})`,
      detail: execution.queue ? `Queue ${execution.queue}, priority ${execution.priority}` : undefined,
      tone: 'neutral',
    },
  ];
  if (new Date(execution.scheduledFor).getTime() - new Date(execution.createdAt).getTime() > 2000) {
    events.push({ key: 'due', at: execution.scheduledFor, title: 'Due', detail: 'Delayed until this time', tone: 'delayed' });
  }
  const attempts: Attempt[] = [...execution.attempts].sort((a, b) => a.attemptNumber - b.attemptNumber);
  attempts.forEach((attempt, index) => {
    const executor = attempt.agent ? `agent ${attempt.agent.hostname ?? attempt.agent.instanceId}` : attempt.worker ? `worker ${attempt.worker.hostname ?? attempt.worker.instanceId}` : 'an executor';
    events.push({ key: `start-${attempt.id}`, at: attempt.startedAt, title: `Attempt ${attempt.attemptNumber} started`, detail: `Claimed by ${executor}`, tone: 'primary' });
    if (attempt.finishedAt) {
      const view = ATTEMPT_STATUS[attempt.status];
      const reason = [attempt.errorCode, attempt.httpStatus ? `HTTP ${attempt.httpStatus}` : null, attempt.errorMessage].filter(Boolean).join(' · ');
      events.push({ key: `end-${attempt.id}`, at: attempt.finishedAt, title: `Attempt ${attempt.attemptNumber} ${view.label.toLowerCase()}`, ...(reason ? { detail: reason } : {}), tone: view.tone });
      const next = attempts[index + 1];
      if (next && attempt.status !== 'SUCCEEDED') events.push({ key: `retry-${attempt.id}`, at: attempt.finishedAt, title: 'Retry scheduled', detail: 'Exponential backoff with jitter', tone: 'warning' });
    }
  });
  if (execution.status === 'RETRY_SCHEDULED' && execution.nextAttemptAt) {
    events.push({ key: 'next-retry', at: execution.nextAttemptAt, title: `Attempt ${execution.attemptCount + 1} scheduled`, tone: 'warning' });
  }
  if (execution.finishedAt) {
    const outcome = { SUCCEEDED: ['Completed', 'success'], FAILED: ['Failed (not retried)', 'danger'], DEAD_LETTERED: ['Dead-lettered: all attempts failed', 'danger'], CANCELLED: ['Cancelled', 'neutral'] } as Record<string, [string, Tone]>;
    const [title, tone] = outcome[execution.status] ?? ['Finished', 'neutral'];
    events.push({ key: 'finished', at: execution.finishedAt, title, ...(execution.lastError && execution.status !== 'SUCCEEDED' ? { detail: execution.lastError } : {}), tone });
  }
  return events.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}
