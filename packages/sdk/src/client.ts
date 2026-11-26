import { randomUUID } from 'node:crypto';
import { QueueSubmissionInput, queueSubmissionSchema } from '@chronos/protocol';
import { ChronosConfigError, ChronosConflictError, ChronosValidationError } from './errors';
import { HttpClient } from './http';

export interface QueueOptions {
  /** Run after this many milliseconds (max 365 days). Omit for immediate execution. */
  delay?: number;
  /** Run at this time instead of after a delay. */
  runAt?: Date | string;
  /** 0-100, higher runs first among waiting executions of the same queue. */
  priority?: number;
  /** Queue name overriding the job's queue (it must exist). */
  queue?: string;
  /**
   * Repeating a call with the same key returns the original execution. When omitted, the
   * SDK generates one per call, so its own retries can never create duplicates.
   */
  idempotencyKey?: string;
  maxAttempts?: number;
  /** Retry backoff overrides for this execution (exponential with jitter). */
  backoff?: { delay?: number; maxDelay?: number };
  timeoutMs?: number;
}

export interface QueuedExecution {
  id: string;
  jobId: string;
  jobName: string;
  queue: string | null;
  status: string;
  trigger: string;
  priority: number;
  /** True while waiting for a future run time. */
  delayed: boolean;
  scheduledFor: Date;
  idempotencyKey: string | null;
  /** False when the idempotency key matched an earlier submission. */
  created: boolean;
}

/** Request body of POST /queue (validated). */
export type SubmissionBody = { job: string } & Record<string, unknown>;

/** Builds and validates a submission body (POST /queue) from SDK-style options. */
export function buildSubmission(job: string, payload: unknown, options: QueueOptions = {}): SubmissionBody {
  const body: QueueSubmissionInput = {
    job,
    ...(payload !== undefined ? { payload } : {}),
    ...(options.delay !== undefined ? { delayMs: options.delay } : {}),
    ...(options.runAt !== undefined ? { runAt: new Date(options.runAt) } : {}),
    ...(options.priority !== undefined ? { priority: options.priority } : {}),
    ...(options.queue !== undefined ? { queue: options.queue } : {}),
    // Always sent, so retries of this call can never create a second execution.
    idempotencyKey: options.idempotencyKey ?? `sdk-${randomUUID()}`,
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
    ...(options.backoff?.delay !== undefined ? { retryBackoffMs: options.backoff.delay } : {}),
    ...(options.backoff?.maxDelay !== undefined ? { retryBackoffMaxMs: options.backoff.maxDelay } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  };
  // Validate locally with the server's schema for fast, precise errors.
  const parsed = queueSubmissionSchema.safeParse(body);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    throw new ChronosValidationError(`Invalid submission for "${job}": ${details.map((d) => `${d.path || 'body'}: ${d.message}`).join('; ')}`, 400, 'VALIDATION_FAILED', details);
  }
  return body as SubmissionBody;
}

type RawSubmission = { execution: Omit<QueuedExecution, 'created' | 'scheduledFor'> & { scheduledFor: string }; created: boolean };

export function toQueuedExecution(data: RawSubmission): QueuedExecution {
  return { ...data.execution, scheduledFor: new Date(data.execution.scheduledFor), created: data.created };
}

/** Submits and cancels executions of one project. */
export class SubmissionClient {
  constructor(
    private readonly http: HttpClient,
    private readonly projectId: () => Promise<string>,
  ) {}

  async queue(job: string, payload: unknown, options: QueueOptions = {}): Promise<QueuedExecution> {
    const body = buildSubmission(job, payload, options);
    const projectId = await this.projectId();
    const data = await this.http.request<RawSubmission>('POST', `/v1/projects/${projectId}/queue`, { body, idempotent: true });
    return toQueuedExecution(data);
  }

  /** true if cancelled; false if it had already started or finished. */
  async cancel(executionId: string): Promise<boolean> {
    const projectId = await this.projectId();
    try {
      await this.http.request('POST', `/v1/projects/${projectId}/executions/${encodeURIComponent(executionId)}/cancel`, { idempotent: true });
      return true;
    } catch (error) {
      if (error instanceof ChronosConflictError) return false;
      throw error;
    }
  }
}

/**
 * Resolves (once, with retry on failure) the id of the project a project key or agent
 * token belongs to, and checks it matches the configured slug.
 */
export function projectIdResolver(http: HttpClient, project: string, path: '/v1/agent/identity' | '/v1/identity'): () => Promise<string> {
  let pending: Promise<string> | undefined;
  return () => {
    if (!pending) {
      pending = http.request<{ projectId: string; projectSlug: string }>('GET', path).then((identity) => {
        if (identity.projectSlug !== project) {
          throw new ChronosConfigError(`This token belongs to project "${identity.projectSlug}", but the client is configured for "${project}"`);
        }
        return identity.projectId;
      });
      pending.catch(() => (pending = undefined)); // retry resolution on the next call
    }
    return pending;
  };
}
