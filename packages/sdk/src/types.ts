/**
 * Response and input shapes of the Chronos REST API (v1), as used by ChronosAdmin.
 * Timestamps are ISO 8601 UTC strings, exactly as the API returns them.
 * Reference: docs/API_REFERENCE.md.
 */

export type ExecutionMode = 'HTTP' | 'AGENT' | 'WORKER';
export type JobSource = 'API' | 'SDK';
export type ExecutionTrigger = 'SCHEDULE' | 'MANUAL' | 'QUEUE';
export type ExecutionStatus = 'PENDING' | 'QUEUED' | 'RUNNING' | 'RETRY_SCHEDULED' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'DEAD_LETTERED';
export type AttemptStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'ABANDONED';
export type ExecutorStatus = 'ONLINE' | 'DRAINING' | 'OFFLINE';
export type ScheduleState = 'ACTIVE' | 'PAUSED' | 'COMPLETED';
export type MisfirePolicy = 'FIRE_ONCE' | 'SKIP' | 'FIRE_ALL';
export type ConcurrencyPolicy = 'ALLOW' | 'FORBID';
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/** Statuses after which an execution never changes again. */
export const TERMINAL_STATUSES: readonly ExecutionStatus[] = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'DEAD_LETTERED'];

/** The project a credential belongs to (GET /v1/identity). */
export interface CredentialIdentity {
  kind: 'PROJECT' | 'AGENT';
  projectId: string;
  projectSlug: string;
  organizationId: string;
  timezone: string;
  credentialId: string;
}

export interface Page<T> {
  items: T[];
  /** Pass as `cursor` to get the next page; null on the last page. */
  nextCursor: string | null;
}

// --- Jobs ------------------------------------------------------------------------------
export interface HttpConfig {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers: Record<string, string>;
  auth?: { type: 'bearer'; token: string } | { type: 'basic'; username: string; password: string };
  signingSecret?: string;
}

export interface JobSchedule {
  type: 'CRON' | 'ONCE';
  cron: string | null;
  runAt: string | null;
  timezone: string;
  state: ScheduleState;
  misfirePolicy: MisfirePolicy;
  misfireGraceMs: number;
  maxCatchUp: number;
  nextRunAt: string | null;
  lastScheduledAt: string | null;
  version: number;
}

export interface LastExecution {
  id: string;
  status: ExecutionStatus;
  trigger: ExecutionTrigger;
  createdAt: string;
  finishedAt: string | null;
}

export interface Job {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  mode: ExecutionMode;
  source: JobSource;
  enabled: boolean;
  queueId: string;
  queue: string;
  priority: number | null;
  maxConcurrency: number | null;
  payloadSchema: Record<string, unknown> | null;
  http: HttpConfig | null;
  payload: unknown;
  timeoutMs: number;
  maxAttempts: number;
  retryBackoffMs: number;
  retryBackoffMaxMs: number;
  concurrencyPolicy: ConcurrencyPolicy;
  createdAt: string;
  updatedAt: string;
  schedule: JobSchedule | null;
  /** Most recent execution (any trigger), when the API provides it. */
  lastExecution?: LastExecution | null;
}

export interface ScheduleDefinitionInput {
  cron?: string;
  runAt?: string;
  timezone?: string;
  misfirePolicy?: MisfirePolicy;
  misfireGraceMs?: number;
  maxCatchUp?: number;
}

/** Fields accepted when creating or updating a job. See CreateJobInput and UpdateJobInput. */
export interface JobInput {
  name?: string;
  description?: string | null;
  mode?: ExecutionMode;
  enabled?: boolean;
  http?: HttpConfig;
  payload?: unknown;
  schedule?: ScheduleDefinitionInput | null;
  timeoutMs?: number;
  maxAttempts?: number;
  retryBackoffMs?: number;
  retryBackoffMaxMs?: number;
  concurrencyPolicy?: ConcurrencyPolicy;
  queue?: string;
  priority?: number | null;
  maxConcurrency?: number | null;
  payloadSchema?: Record<string, unknown> | null;
}

/** POST /jobs: name and mode are required; HTTP jobs also need `http`. */
export type CreateJobInput = JobInput & { name: string; mode: ExecutionMode };

/** PATCH /jobs/:id: any subset of fields except `name`; `schedule: null` removes the schedule. */
export type UpdateJobInput = Omit<JobInput, 'name'>;

export interface JobListFilters {
  mode?: ExecutionMode;
  enabled?: boolean;
  source?: JobSource;
  queue?: string;
  /** Text search in name and description. */
  search?: string;
}

// --- Queues and submissions -------------------------------------------------------------

export interface QueueCounts {
  waiting: number;
  delayed: number;
  retrying: number;
  queued: number;
  running: number;
}

export interface Queue {
  id: string;
  name: string;
  description: string | null;
  concurrencyLimit: number | null;
  defaultPriority: number;
  paused: boolean;
  createdAt: string;
  updatedAt: string;
  counts: QueueCounts;
  jobs: number;
}

export interface SubmittedExecution {
  id: string;
  jobId: string;
  jobName: string;
  queue: string | null;
  status: ExecutionStatus;
  trigger: ExecutionTrigger;
  priority: number;
  delayed: boolean;
  scheduledFor: string;
  nextAttemptAt: string | null;
  idempotencyKey: string | null;
  maxAttempts: number;
  timeoutMs: number;
  createdAt: string;
}

export interface SubmissionResult {
  execution: SubmittedExecution;
  /** False when the idempotency key matched an earlier submission. */
  created: boolean;
}

/** Result of triggering a job manually. Use executions.get()/wait() for the details. */
export interface TriggeredExecution {
  id: string;
  jobId: string;
  status: ExecutionStatus;
  trigger: ExecutionTrigger;
  scheduledFor: string;
  idempotencyKey: string | null;
  /** False when the idempotency key matched an earlier trigger. */
  created: boolean;
}

export interface QueueInput {
  name: string;
  description?: string | null;
  /** Executions of this queue admitted at once; null = unlimited. */
  concurrencyLimit?: number | null;
  defaultPriority?: number;
}

export type QueueUpdate = Omit<QueueInput, 'name'>;

export interface BatchItemResult {
  index: number;
  outcome: 'created' | 'duplicate' | 'error';
  execution?: SubmittedExecution;
  error?: { status: number; code: string; message: string; details?: unknown };
}

export interface BatchResult {
  results: BatchItemResult[];
  summary: { created: number; duplicate: number; failed: number };
}

// --- Executions ------------------------------------------------------------------------

export interface ExecutionSummary {
  id: string;
  jobId: string;
  jobName: string;
  queue: string | null;
  priority: number;
  delayed: boolean;
  trigger: ExecutionTrigger;
  status: ExecutionStatus;
  mode: ExecutionMode;
  scheduledFor: string;
  idempotencyKey: string;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  createdAt: string;
  /** Who ran the latest attempt (list endpoint only). */
  executor?: { kind: 'AGENT' | 'WORKER'; id: string; name: string } | null;
}

export interface ExecutorRef {
  id: string;
  hostname: string | null;
  instanceId: string;
}

export interface Attempt {
  id: string;
  attemptNumber: number;
  status: AttemptStatus;
  agentId: string | null;
  workerId: string | null;
  agent: ExecutorRef | null;
  worker: ExecutorRef | null;
  startedAt: string;
  finishedAt: string | null;
  leaseExpiresAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  httpStatus: number | null;
  output: unknown;
}

export interface ExecutionLog {
  id: string;
  executionId: string;
  attemptId: string | null;
  level: LogLevel;
  message: string;
  data: unknown;
  createdAt: string;
}

export interface ExecutionDetail extends ExecutionSummary {
  projectId: string;
  payload: unknown;
  timeoutMs: number;
  retryBackoffMs: number;
  retryBackoffMaxMs: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  result: unknown;
  updatedAt: string;
  attempts: Attempt[];
  logs: ExecutionLog[];
  logsTruncated: boolean;
}


export interface ExecutionFilters {
  /** Job id or name. */
  job?: string;
  status?: ExecutionStatus | ExecutionStatus[];
  trigger?: ExecutionTrigger;
  mode?: ExecutionMode;
  queue?: string;
  delayed?: boolean;
  agentId?: string;
  workerId?: string;
  /** Created at or after. */
  from?: Date | string;
  /** Created before. */
  to?: Date | string;
  /** Page size, 1-100 (default 50). */
  limit?: number;
  cursor?: string;
}

// --- Statistics --------------------------------------------------------------------------

export type StatusCounts = Partial<Record<ExecutionStatus, number>>;

export interface ProjectStats {
  windowHours: number;
  jobId: string | null;
  executions: StatusCounts;
  jobs: number;
  jobsEnabled: number;
  jobsPaused: number;
  agentsOnline: number;
  durationMs: { p50: number | null; p95: number | null };
  byMode?: Partial<Record<ExecutionMode, number>>;
  byKind?: { scheduled: number; manual: number; immediate: number; delayed: number };
}

export interface TimeseriesPoint {
  at: string;
  counts: StatusCounts;
  byMode?: Partial<Record<ExecutionMode, number>>;
  byKind?: { scheduled: number; manual: number; immediate: number; delayed: number };
  durationMs?: { p50: number | null; p95: number | null };
}

export interface Timeseries {
  bucket: 'hour' | 'day';
  windowHours: number;
  points: TimeseriesPoint[];
}

export interface UpcomingOccurrence {
  at: string;
  jobId: string;
  jobName: string;
  mode: ExecutionMode;
}

export interface Upcoming {
  from: string;
  to: string;
  occurrences: UpcomingOccurrence[];
  truncated: boolean;
  truncatedJobs: string[];
}

export interface SchedulePreview {
  type: 'CRON' | 'ONCE';
  timezone: string;
  occurrences: string[];
  inPast: boolean;
}

// --- Agents and workers ------------------------------------------------------------------

export interface Agent {
  id: string;
  credentialId: string | null;
  instanceId: string;
  hostname: string | null;
  sdkVersion: string;
  protocolVersion: number;
  status: ExecutorStatus;
  handlers: string[];
  connectedAt: string;
  lastHeartbeatAt: string;
  disconnectedAt: string | null;
}

export interface AgentDetail extends Agent {
  metadata: unknown;
  runningExecutions: number;
}
