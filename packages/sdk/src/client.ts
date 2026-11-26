import { randomUUID } from 'node:crypto';
import { QueueSubmissionInput, queueSubmissionSchema } from '@chronos/protocol';
import {
  ChronosAuthError,
  ChronosConfigError,
  ChronosConflictError,
  ChronosNotFoundError,
  ChronosRequestError,
  ChronosValidationError,
} from './errors';

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

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/** REST calls made with the agent token: job submission and cancellation only. */
export class SubmissionClient {
  private projectId?: Promise<string>;

  constructor(
    private readonly options: {
      server: string;
      project: string;
      token: () => string | undefined;
      userAgent: string;
      maxAttempts?: number;
      requestTimeoutMs?: number;
    },
  ) {}

  async queue(job: string, payload: unknown, options: QueueOptions = {}): Promise<QueuedExecution> {
    const body: QueueSubmissionInput = {
      job,
      ...(payload !== undefined ? { payload } : {}),
      ...(options.delay !== undefined ? { delayMs: options.delay } : {}),
      ...(options.runAt !== undefined ? { runAt: new Date(options.runAt) } : {}),
      ...(options.priority !== undefined ? { priority: options.priority } : {}),
      ...(options.queue !== undefined ? { queue: options.queue } : {}),
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
    const projectId = await this.resolveProjectId();
    const data = await this.request<{ execution: Omit<QueuedExecution, 'created' | 'scheduledFor'> & { scheduledFor: string }; created: boolean }>(
      'POST',
      `/v1/projects/${projectId}/queue`,
      body,
    );
    return { ...data.execution, scheduledFor: new Date(data.execution.scheduledFor), created: data.created };
  }

  /** true if cancelled; false if it had already started or finished. */
  async cancel(executionId: string): Promise<boolean> {
    const projectId = await this.resolveProjectId();
    try {
      await this.request('POST', `/v1/projects/${projectId}/executions/${encodeURIComponent(executionId)}/cancel`);
      return true;
    } catch (error) {
      if (error instanceof ChronosConflictError) return false;
      throw error;
    }
  }

  private resolveProjectId(): Promise<string> {
    if (!this.projectId) {
      this.projectId = this.request<{ projectId: string; projectSlug: string }>('GET', '/v1/agent/identity').then((identity) => {
        if (identity.projectSlug !== this.options.project) {
          throw new ChronosConfigError(`This agent token belongs to project "${identity.projectSlug}", but the SDK is configured for "${this.options.project}"`);
        }
        return identity.projectId;
      });
      this.projectId.catch(() => (this.projectId = undefined)); // retry resolution on the next call
    }
    return this.projectId;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = this.options.token();
    if (!token) throw new ChronosConfigError('An agent token is required: pass "token" or set CHRONOS_AGENT_TOKEN');
    const url = new URL(path, this.options.server.endsWith('/') ? this.options.server : `${this.options.server}/`).toString();
    const attempts = this.options.maxAttempts ?? 5;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            'User-Agent': this.options.userAgent,
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 10_000),
        });
      } catch (error) {
        lastError = new ChronosRequestError(`Request to Chronos failed: ${error instanceof Error ? error.message : String(error)}`, 0, 'NETWORK_ERROR');
        await backoff(attempt, attempts);
        continue;
      }
      const json = (await response.json().catch(() => ({}))) as { data?: T; error?: { code?: string; message?: string; details?: unknown } };
      if (response.ok) return json.data as T;
      const error = toError(response.status, json.error);
      if (!RETRYABLE_STATUS.has(response.status)) throw error;
      lastError = error;
      const retryAfter = Number(response.headers.get('retry-after'));
      await backoff(attempt, attempts, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined);
    }
    throw lastError;
  }
}

async function backoff(attempt: number, attempts: number, overrideMs?: number): Promise<void> {
  if (attempt >= attempts) return;
  const delay = overrideMs ?? Math.min(5_000, 200 * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2);
  await new Promise((resolve) => setTimeout(resolve, delay));
}

function toError(status: number, error: { code?: string; message?: string; details?: unknown } | undefined): ChronosRequestError {
  const code = error?.code ?? 'HTTP_ERROR';
  const message = error?.message ?? `Chronos responded with HTTP ${status}`;
  if (status === 400) return new ChronosValidationError(message, status, code, error?.details);
  if (status === 401 || status === 403) return new ChronosAuthError(message, status, code, error?.details);
  if (status === 404) return new ChronosNotFoundError(message, status, code, error?.details);
  if (status === 409) return new ChronosConflictError(message, status, code, error?.details);
  return new ChronosRequestError(message, status, code, error?.details);
}
