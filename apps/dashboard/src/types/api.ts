/**
 * Response and request types of the Chronos REST API (v1), written against the actual
 * controllers and services in apps/server. See docs/API_REFERENCE.md. Dates arrive as
 * ISO strings.
 */

export type OrgRole = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';
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

export const TERMINAL_STATUSES: readonly ExecutionStatus[] = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'DEAD_LETTERED'];
export const ACTIVE_STATUSES: readonly ExecutionStatus[] = ['PENDING', 'QUEUED', 'RUNNING', 'RETRY_SCHEDULED'];

export interface ApiEnvelope<T> {
  data: T;
  meta: { requestId: string; apiVersion: '1' };
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
  meta?: { requestId: string };
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

// --- Auth, organizations, projects -----------------------------------------------------

export interface Me {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  lastLoginAt: string | null;
  organizations: { id: string; name: string; slug: string; role: OrgRole }[];
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
  projectCount?: number;
  memberCount?: number;
  role?: OrgRole;
}

export interface Member {
  id: string;
  email: string;
  name: string;
  isActive: boolean;
  role: OrgRole;
  joinedAt: string;
}

export interface Project {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  timezone: string;
  createdAt: string;
  updatedAt: string;
}

export interface Credential {
  id: string;
  kind: 'PROJECT' | 'AGENT';
  name: string;
  displayPrefix: string;
  projectId: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  rotatedFromId: string | null;
  createdAt: string;
}

export interface IssuedCredential extends Credential {
  /** Shown exactly once. */
  token: string;
}

export interface SystemInfo {
  version: string;
  apiVersion: string;
  agentProtocolVersion: number;
  serverTime: string;
  features: { embeddedScheduler: boolean; embeddedWorker: boolean; bundledDashboard: boolean; eventStream: boolean };
  limits: { userTokenTtlHours: number; executionRetentionDays: number; agentHeartbeatMs: number; leaseMs: number; eventsPollMs: number };
}

export interface BootstrapResult {
  user: { id: string; email: string; name: string };
  organization: { id: string; name: string; slug: string };
  project: { id: string; name: string; slug: string; timezone: string };
  credentials: { projectKey: { id: string; token: string }; agentToken: { id: string; token: string } };
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

export interface QueueSubmissionInput {
  job: string;
  payload?: unknown;
  delayMs?: number;
  runAt?: string;
  priority?: number;
  queue?: string;
  idempotencyKey?: string;
  maxAttempts?: number;
  retryBackoffMs?: number;
  retryBackoffMaxMs?: number;
  timeoutMs?: number;
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
  created: boolean;
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
  jobId?: string;
  status?: ExecutionStatus[];
  trigger?: ExecutionTrigger;
  mode?: ExecutionMode;
  queue?: string;
  delayed?: boolean;
  agentId?: string;
  workerId?: string;
  from?: string;
  to?: string;
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

export interface Worker {
  id: string;
  instanceId: string;
  hostname: string | null;
  version: string;
  status: ExecutorStatus;
  concurrency: number;
  startedAt: string;
  lastHeartbeatAt: string;
  stoppedAt: string | null;
  runningExecutions?: number;
}

export interface WorkerDetail extends Worker {
  runningExecutions: number;
  attempts24h: { succeeded: number; failed: number; timedOut: number; abandoned: number };
  modes: string[];
  recentAttempts: {
    executionId: string;
    attemptNumber: number;
    status: AttemptStatus;
    jobName: string;
    projectId: string;
    startedAt: string;
    finishedAt: string | null;
    errorCode: string | null;
  }[];
}

// --- Activity ------------------------------------------------------------------------------

export interface AuditEntry {
  id: string;
  action: string;
  projectId: string | null;
  actor: {
    type: 'USER' | 'CREDENTIAL' | 'SYSTEM';
    id: string | null;
    name: string | null;
    email: string | null;
    credentialKind: 'PROJECT' | 'AGENT' | 'USER' | null;
    credentialPrefix: string | null;
  };
  targetType: string | null;
  targetId: string | null;
  metadata: unknown;
  requestId: string | null;
  ipAddress: string | null;
  createdAt: string;
}

// --- Real-time events ---------------------------------------------------------------------

export interface ExecutionEvent {
  id: string;
  jobId: string;
  jobName: string;
  queue: string | null;
  priority: number;
  delayed: boolean;
  status: ExecutionStatus;
  trigger: ExecutionTrigger;
  mode: ExecutionMode;
  attemptCount: number;
  maxAttempts: number;
  scheduledFor: string;
  nextAttemptAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  updatedAt: string;
}
