import { MAX_BATCH_SUBMISSIONS } from '@chronos/protocol';
import { QueueOptions, QueuedExecution, SubmissionClient, buildSubmission, projectIdResolver } from './client';
import { ChronosConfigError, ChronosNotFoundError, ChronosWaitTimeoutError } from './errors';
import { HttpClient } from './http';
import { SDK_VERSION } from './version';
import {
  Agent,
  AgentDetail,
  BatchResult,
  CreateJobInput,
  CredentialIdentity,
  ExecutionDetail,
  ExecutionFilters,
  ExecutionLog,
  ExecutionStatus,
  ExecutionSummary,
  ExecutorStatus,
  Job,
  JobListFilters,
  Page,
  ProjectStats,
  Queue,
  QueueInput,
  QueueUpdate,
  ScheduleDefinitionInput,
  SchedulePreview,
  TERMINAL_STATUSES,
  TriggeredExecution,
  Timeseries,
  Upcoming,
  UpdateJobInput,
} from './types';

export interface ChronosAdminOptions {
  /** Chronos server base URL, e.g. https://chronos.example.com */
  server: string;
  /** Project slug. The token must belong to this project. */
  project: string;
  /**
   * A project API key (`chr_p_…`, recommended for services) or a user session token
   * (`chr_u_…`). Defaults to the CHRONOS_API_KEY environment variable.
   */
  token?: string;
  /** Attempts per request for retryable failures, including the first (default 5). */
  maxAttempts?: number;
  /** Per-attempt request timeout in ms (default 10 000). */
  requestTimeoutMs?: number;
}

/** A job is addressed by its id (UUID) or its name. */
export type JobRef = string;

export interface WaitOptions {
  /** Give up after this many ms (default 60 000). */
  timeoutMs?: number;
  /** Poll interval in ms (default 1000). */
  intervalMs?: number;
  signal?: AbortSignal;
}

export interface BatchItem<TPayload = unknown> {
  job: string;
  payload?: TPayload;
  options?: QueueOptions;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Manages a Chronos project from code: jobs, schedules, queues, executions, agents and
 * statistics. The counterpart of an admin client in a message broker library.
 *
 * Project API keys act with MEMBER rights: they can do everything here except create,
 * update or delete queues and remove agents, which need an ADMIN user's token.
 *
 * @example
 * const admin = new ChronosAdmin({ server: 'https://chronos.example.com', project: 'storefront', token: process.env.CHRONOS_API_KEY });
 * await admin.jobs.create({ name: 'nightly-report', mode: 'AGENT', schedule: { cron: '0 2 * * *' } });
 * const { id } = await admin.jobs.trigger('nightly-report');
 * const done = await admin.executions.wait(id);
 */
export class ChronosAdmin {
  readonly jobs: JobsApi;
  readonly queues: QueuesApi;
  readonly executions: ExecutionsApi;
  readonly schedules: SchedulesApi;
  readonly agents: AgentsApi;
  readonly stats: StatsApi;

  private readonly http: HttpClient;
  private readonly submissions: SubmissionClient;
  /** Resolves the project id once (and again after a failure). */
  readonly projectId: () => Promise<string>;

  constructor(private readonly options: ChronosAdminOptions) {
    if (!options || typeof options.server !== 'string' || options.server.length === 0) throw new ChronosConfigError('"server" is required');
    if (typeof options.project !== 'string' || options.project.length === 0) throw new ChronosConfigError('"project" is required');
    this.http = new HttpClient({
      server: options.server,
      token: () => this.options.token ?? process.env.CHRONOS_API_KEY,
      missingTokenMessage: 'A project API key or user token is required: pass "token" or set CHRONOS_API_KEY',
      userAgent: `chronos-sdk-node/${SDK_VERSION} admin`,
      ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
      ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    });
    const byKey = projectIdResolver(this.http, options.project, '/v1/identity');
    let byUser: Promise<string> | undefined;
    this.projectId = () => {
      const token = this.options.token ?? process.env.CHRONOS_API_KEY ?? '';
      if (!token.startsWith('chr_u_')) return byKey();
      if (!byUser) {
        byUser = this.findProjectForUser();
        byUser.catch(() => (byUser = undefined));
      }
      return byUser;
    };
    this.submissions = new SubmissionClient(this.http, this.projectId);
    const ctx: ApiContext = { http: this.http, path: (suffix) => this.projectId().then((id) => `/v1/projects/${id}${suffix}`) };
    this.jobs = new JobsApi(ctx);
    this.queues = new QueuesApi(ctx);
    this.executions = new ExecutionsApi(ctx, this.jobs);
    this.schedules = new SchedulesApi(ctx, this.jobs);
    this.agents = new AgentsApi(ctx);
    this.stats = new StatsApi(ctx, this.jobs);
  }

  /** The project this client manages. Fails fast on a bad token or wrong project slug. */
  async project(): Promise<{ id: string; slug: string; name: string; timezone: string; organizationId: string }> {
    const id = await this.projectId();
    return this.http.request('GET', `/v1/projects/${id}`);
  }

  /** The project a project key belongs to (not available for user tokens). */
  identity(): Promise<CredentialIdentity> {
    return this.http.request('GET', '/v1/identity');
  }

  /**
   * Submits a job for asynchronous execution, immediately or after `options.delay` ms /
   * at `options.runAt`. Retries use one idempotency key, so a call creates at most one execution.
   */
  queue<TPayload = unknown>(job: string, payload?: TPayload, options?: QueueOptions): Promise<QueuedExecution> {
    return this.submissions.queue(job, payload, options);
  }

  /** Submits up to 100 jobs in one request. Each item succeeds or fails on its own. */
  async queueBatch(items: BatchItem[]): Promise<BatchResult> {
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_BATCH_SUBMISSIONS) {
      throw new ChronosConfigError(`queueBatch() takes 1-${MAX_BATCH_SUBMISSIONS} items`);
    }
    const body = { items: items.map((item) => buildSubmission(item.job, item.payload, item.options)) };
    return this.http.request('POST', await this.pathFor('/queue/batch'), { body, idempotent: true });
  }

  /** Cancels an execution that has not finished. Resolves false if it already finished. */
  cancel(executionId: string): Promise<boolean> {
    return this.submissions.cancel(executionId);
  }

  private async pathFor(suffix: string): Promise<string> {
    return `/v1/projects/${await this.projectId()}${suffix}`;
  }

  private async findProjectForUser(): Promise<string> {
    const organizations = await this.http.request<Array<{ id: string; slug: string }>>('GET', '/v1/organizations');
    const matches: string[] = [];
    for (const organization of organizations) {
      const projects = await this.http.request<Array<{ id: string; slug: string }>>('GET', `/v1/organizations/${organization.id}/projects`);
      for (const project of projects) if (project.slug === this.options.project) matches.push(project.id);
    }
    if (matches.length === 0) throw new ChronosNotFoundError(`No project "${this.options.project}" in your organizations`, 404, 'NOT_FOUND');
    if (matches.length > 1) throw new ChronosConfigError(`Project slug "${this.options.project}" exists in several of your organizations; use a project API key`);
    return matches[0]!;
  }
}

interface ApiContext {
  http: HttpClient;
  /** Project-scoped path, e.g. path('/jobs') → /v1/projects/<id>/jobs */
  path: (suffix: string) => Promise<string>;
}

function iso(value: Date | string | undefined): string | undefined {
  return value === undefined ? undefined : new Date(value).toISOString();
}

export class JobsApi {
  /** name → id, filled as jobs are looked up. */
  private readonly ids = new Map<string, string>();

  constructor(private readonly ctx: ApiContext) {}

  async list(filters: JobListFilters = {}): Promise<Job[]> {
    const jobs = await this.ctx.http.request<Job[]>('GET', await this.ctx.path('/jobs'), {
      query: { mode: filters.mode, enabled: filters.enabled, source: filters.source, queue: filters.queue, q: filters.search },
    });
    for (const job of jobs) this.ids.set(job.name, job.id);
    return jobs;
  }

  async get(job: JobRef): Promise<Job> {
    return this.withId(job, async (id) => this.ctx.http.request<Job>('GET', await this.ctx.path(`/jobs/${id}`)));
  }

  /** Creates a job. HTTP jobs need `http`; AGENT and WORKER jobs run handlers named like the job. */
  async create(input: CreateJobInput): Promise<Job> {
    const job = await this.ctx.http.request<Job>('POST', await this.ctx.path('/jobs'), { body: input });
    this.ids.set(job.name, job.id);
    return job;
  }

  /** Updates fields (not the name). SDK-managed jobs only accept `enabled`. */
  async update(job: JobRef, changes: UpdateJobInput): Promise<Job> {
    return this.withId(job, async (id) => this.ctx.http.request<Job>('PATCH', await this.ctx.path(`/jobs/${id}`), { body: changes }));
  }

  /** Deletes the job and its execution history. */
  async delete(job: JobRef): Promise<void> {
    await this.withId(job, async (id) => this.ctx.http.request<void>('DELETE', await this.ctx.path(`/jobs/${id}`), { idempotent: true }));
    if (!UUID.test(job)) this.ids.delete(job);
  }

  enable(job: JobRef): Promise<Job> {
    return this.update(job, { enabled: true });
  }

  disable(job: JobRef): Promise<Job> {
    return this.update(job, { enabled: false });
  }

  /** Pauses the job's schedule (manual triggers and submissions still run). */
  async pause(job: JobRef): Promise<Job> {
    return this.withId(job, async (id) => this.ctx.http.request<Job>('POST', await this.ctx.path(`/jobs/${id}/pause`), { idempotent: true }));
  }

  /** Resumes the schedule; the next run is computed from now. */
  async resume(job: JobRef): Promise<Job> {
    return this.withId(job, async (id) => this.ctx.http.request<Job>('POST', await this.ctx.path(`/jobs/${id}/resume`), { idempotent: true }));
  }

  /** Runs the job now (trigger MANUAL). Pass an idempotency key to make retries safe. */
  async trigger(job: JobRef, options: { payload?: unknown; idempotencyKey?: string } = {}): Promise<TriggeredExecution> {
    const body = { ...(options.payload !== undefined ? { payload: options.payload } : {}), ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}) };
    const result = await this.withId(job, async (id) =>
      this.ctx.http.request<{ execution: Omit<TriggeredExecution, 'created'>; created: boolean }>('POST', await this.ctx.path(`/jobs/${id}/trigger`), {
        body,
        idempotent: Boolean(options.idempotencyKey),
      }),
    );
    const { id, jobId, status, trigger, scheduledFor, idempotencyKey } = result.execution;
    return { id, jobId, status, trigger, scheduledFor, idempotencyKey, created: result.created };
  }

  /** Next run times of the job's saved schedule. */
  async nextRuns(job: JobRef, count = 5): Promise<{ timezone: string; occurrences: string[] }> {
    return this.withId(job, async (id) => this.ctx.http.request('GET', await this.ctx.path(`/jobs/${id}/schedule/preview`), { query: { count } }));
  }

  /** Job id for an id or name. */
  async resolveId(job: JobRef): Promise<string> {
    if (UUID.test(job)) return job;
    const cached = this.ids.get(job);
    if (cached) return cached;
    const matches = await this.list({ search: job });
    const found = matches.find((candidate) => candidate.name === job);
    if (!found) throw new ChronosNotFoundError(`Job "${job}" not found`, 404, 'NOT_FOUND');
    return found.id;
  }

  /** Runs `call` with the job's id; a stale cached id (job deleted and recreated) is refreshed once. */
  private async withId<T>(job: JobRef, call: (id: string) => Promise<T>): Promise<T> {
    const cached = !UUID.test(job) && this.ids.has(job);
    try {
      return await call(await this.resolveId(job));
    } catch (error) {
      if (!(cached && error instanceof ChronosNotFoundError)) throw error;
      this.ids.delete(job);
      return call(await this.resolveId(job));
    }
  }
}

export class QueuesApi {
  constructor(private readonly ctx: ApiContext) {}

  async list(): Promise<Queue[]> {
    return this.ctx.http.request('GET', await this.ctx.path('/queues'));
  }

  async get(name: string): Promise<Queue> {
    return this.ctx.http.request('GET', await this.ctx.path(`/queues/${encodeURIComponent(name)}`));
  }

  /** Needs an ADMIN user's token. */
  async create(input: QueueInput): Promise<Queue> {
    return this.ctx.http.request('POST', await this.ctx.path('/queues'), { body: input });
  }

  /** Needs an ADMIN user's token. `concurrencyLimit: null` removes the limit. */
  async update(name: string, changes: QueueUpdate): Promise<Queue> {
    return this.ctx.http.request('PATCH', await this.ctx.path(`/queues/${encodeURIComponent(name)}`), { body: changes });
  }

  /** Needs an ADMIN user's token. Fails for "default", queues with jobs, or unfinished executions. */
  async delete(name: string): Promise<void> {
    await this.ctx.http.request('DELETE', await this.ctx.path(`/queues/${encodeURIComponent(name)}`), { idempotent: true });
  }

  /** Stops admitting new executions from this queue (running ones finish). */
  async pause(name: string): Promise<Queue> {
    return this.ctx.http.request('POST', await this.ctx.path(`/queues/${encodeURIComponent(name)}/pause`), { idempotent: true });
  }

  async resume(name: string): Promise<Queue> {
    return this.ctx.http.request('POST', await this.ctx.path(`/queues/${encodeURIComponent(name)}/resume`), { idempotent: true });
  }
}

export class ExecutionsApi {
  constructor(
    private readonly ctx: ApiContext,
    private readonly jobs: JobsApi,
  ) {}

  /** One page, newest first. Pass `nextCursor` back as `cursor` for the next page. */
  async list(filters: ExecutionFilters = {}): Promise<Page<ExecutionSummary>> {
    const status = Array.isArray(filters.status) ? filters.status.join(',') : filters.status;
    return this.ctx.http.request('GET', await this.ctx.path('/executions'), {
      query: {
        jobId: filters.job !== undefined ? await this.jobs.resolveId(filters.job) : undefined,
        status,
        trigger: filters.trigger,
        mode: filters.mode,
        queue: filters.queue,
        delayed: filters.delayed,
        agentId: filters.agentId,
        workerId: filters.workerId,
        from: iso(filters.from),
        to: iso(filters.to),
        limit: filters.limit,
        cursor: filters.cursor,
      },
    });
  }

  /**
   * Every matching execution, page by page.
   * @example for await (const execution of admin.executions.iterate({ status: 'DEAD_LETTERED' })) { … }
   */
  async *iterate(filters: Omit<ExecutionFilters, 'cursor'> = {}): AsyncGenerator<ExecutionSummary> {
    let cursor: string | undefined;
    do {
      const page = await this.list({ ...filters, ...(cursor ? { cursor } : {}) });
      yield* page.items;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }

  /** Execution with attempts and the first 500 log lines. */
  async get(executionId: string): Promise<ExecutionDetail> {
    return this.ctx.http.request('GET', await this.ctx.path(`/executions/${encodeURIComponent(executionId)}`));
  }

  /** Log lines, oldest first. Poll with `afterId: nextAfterId` to follow a running execution. */
  async logs(executionId: string, options: { afterId?: string; limit?: number } = {}): Promise<{ items: ExecutionLog[]; nextAfterId: string | null }> {
    return this.ctx.http.request('GET', await this.ctx.path(`/executions/${encodeURIComponent(executionId)}/logs`), {
      query: { afterId: options.afterId, limit: options.limit },
    });
  }

  /** Cancels an unfinished execution. Resolves its previous status. */
  async cancel(executionId: string): Promise<{ id: string; status: 'CANCELLED'; previousStatus: ExecutionStatus }> {
    return this.ctx.http.request('POST', await this.ctx.path(`/executions/${encodeURIComponent(executionId)}/cancel`), { idempotent: true });
  }

  /** Runs a FAILED, DEAD_LETTERED or CANCELLED execution again (replay). */
  async retry(executionId: string): Promise<{ id: string; status: 'PENDING' }> {
    return this.ctx.http.request('POST', await this.ctx.path(`/executions/${encodeURIComponent(executionId)}/retry`));
  }

  /**
   * Polls until the execution reaches a terminal status (SUCCEEDED, FAILED, CANCELLED or
   * DEAD_LETTERED) and resolves it. Throws ChronosWaitTimeoutError after `timeoutMs`.
   */
  async wait(executionId: string, options: WaitOptions = {}): Promise<ExecutionDetail> {
    const timeoutMs = options.timeoutMs ?? 60_000;
    const intervalMs = Math.max(100, options.intervalMs ?? 1000);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      options.signal?.throwIfAborted();
      const execution = await this.get(executionId);
      if (TERMINAL_STATUSES.includes(execution.status)) return execution;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new ChronosWaitTimeoutError(`Execution ${executionId} is still ${execution.status} after ${timeoutMs} ms`, execution.status);
      await sleep(Math.min(intervalMs, remaining), options.signal);
    }
  }
}

export class SchedulesApi {
  constructor(
    private readonly ctx: ApiContext,
    private readonly jobs: JobsApi,
  ) {}

  /** Validates a schedule and lists its next occurrences. Nothing is saved. */
  async preview(schedule: ScheduleDefinitionInput, count = 10): Promise<SchedulePreview> {
    return this.ctx.http.request('POST', await this.ctx.path('/schedule/preview'), { body: { schedule, count }, idempotent: true });
  }

  /** Scheduled runs of all jobs (or one job) between `from` (default now) and `to`. */
  async upcoming(options: { to: Date | string; from?: Date | string; job?: JobRef }): Promise<Upcoming> {
    return this.ctx.http.request('GET', await this.ctx.path('/schedule/upcoming'), {
      query: { from: iso(options.from), to: iso(options.to), jobId: options.job !== undefined ? await this.jobs.resolveId(options.job) : undefined },
    });
  }
}

export class AgentsApi {
  constructor(private readonly ctx: ApiContext) {}

  async list(options: { status?: ExecutorStatus } = {}): Promise<Agent[]> {
    return this.ctx.http.request('GET', await this.ctx.path('/agents'), { query: { status: options.status } });
  }

  async get(agentId: string): Promise<AgentDetail> {
    return this.ctx.http.request('GET', await this.ctx.path(`/agents/${encodeURIComponent(agentId)}`));
  }

  /** Removes an OFFLINE agent record. Needs an ADMIN user's token. */
  async remove(agentId: string): Promise<void> {
    await this.ctx.http.request('DELETE', await this.ctx.path(`/agents/${encodeURIComponent(agentId)}`), { idempotent: true });
  }
}

export class StatsApi {
  constructor(
    private readonly ctx: ApiContext,
    private readonly jobs: JobsApi,
  ) {}

  /** Execution counts by status, mode and kind, durations and job/agent counts for the last `hours`. */
  async summary(options: { hours?: number; job?: JobRef; queue?: string } = {}): Promise<ProjectStats> {
    return this.ctx.http.request('GET', await this.ctx.path('/stats'), {
      query: { hours: options.hours, queue: options.queue, jobId: options.job !== undefined ? await this.jobs.resolveId(options.job) : undefined },
    });
  }

  async timeseries(options: { hours?: number; bucket?: 'hour' | 'day'; job?: JobRef; queue?: string; mode?: Job['mode'] } = {}): Promise<Timeseries> {
    return this.ctx.http.request('GET', await this.ctx.path('/stats/timeseries'), {
      query: {
        hours: options.hours,
        bucket: options.bucket,
        queue: options.queue,
        mode: options.mode,
        jobId: options.job !== undefined ? await this.jobs.resolveId(options.job) : undefined,
      },
    });
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
