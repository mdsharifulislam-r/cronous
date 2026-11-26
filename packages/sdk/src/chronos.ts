import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { hostname as osHostname } from 'node:os';
import WebSocket, { RawData } from 'ws';
import {
  AGENT_WS_PATH,
  AgentTaskDefinition,
  AgentTaskDefinitionInput,
  CloseCode,
  ExecuteMessage,
  FATAL_CLOSE_CODES,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  ResultMessage,
  ServerMessage,
  agentTaskDefinitionSchema,
  serverMessageSchema,
} from '@chronos/protocol';
import { agentSocketUrl, reconnectDelay } from './backoff';
import { QueueOptions, QueuedExecution, SubmissionClient, projectIdResolver } from './client';
import { HttpClient } from './http';
import { SDK_VERSION } from './version';
import { ChronosAdmin } from './admin';
import { ChronosConfigError, ChronosConnectionError, NonRetryableError } from './errors';

export { SDK_VERSION } from './version';

export interface ChronosLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface ChronosOptions {
  /** Chronos server base URL, e.g. https://chronos.example.com */
  server: string;
  /** Project slug. Must match the project the agent token belongs to. */
  project: string;
  /** Agent token (chr_a_...). Defaults to process.env.CHRONOS_AGENT_TOKEN. */
  token?: string;
  /** Default IANA time zone for task schedules. Defaults to the project's time zone. */
  timezone?: string;
  /** Maximum handlers running at once in this process. Default 5. */
  concurrency?: number;
  /** Stable id of this process; generated per start by default. */
  instanceId?: string;
  hostname?: string;
  /** Pass `false` to silence the SDK. Defaults to console (debug only with CHRONOS_DEBUG=1). */
  logger?: ChronosLogger | false;
  reconnect?: { initialDelayMs?: number; maxDelayMs?: number };
  /** How long stop() waits for running handlers before aborting them. Default 30s. */
  shutdownTimeoutMs?: number;
}

export interface TaskOptions {
  /** 5-field cron expression, e.g. "0 2 * * *". Omit for tasks that are only triggered manually. */
  schedule?: string;
  /** One-time run at this instant (instead of `schedule`). */
  runAt?: Date | string;
  timezone?: string;
  misfirePolicy?: 'FIRE_ONCE' | 'SKIP' | 'FIRE_ALL';
  misfireGraceMs?: number;
  maxCatchUp?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  retryBackoffMs?: number;
  retryBackoffMaxMs?: number;
  /** FORBID skips an occurrence while the previous one is still running. */
  concurrencyPolicy?: 'ALLOW' | 'FORBID';
  description?: string;
  /** Queue (admission lane) this task's executions go through; created if missing. Default "default". */
  queue?: string;
  /** Default priority of this task's executions, 0-100 (higher first). */
  priority?: number;
  /** At most this many executions of this task admitted at once, across all agents. */
  maxConcurrency?: number;
  /** JSON Schema (draft 2020-12) that every payload submitted for this task must satisfy. */
  payloadSchema?: Record<string, unknown>;
}

export interface TaskLogger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

export interface TaskContext<TPayload = unknown> {
  executionId: string;
  /** 1 for the first attempt; higher on retries. */
  attempt: number;
  task: string;
  scheduledFor: Date;
  /** Stable across retries of the same execution: use it to make side effects idempotent. */
  idempotencyKey: string;
  payload: TPayload;
  /** Aborted on timeout, cancellation or shutdown. Pass it to fetch() and other APIs. */
  signal: AbortSignal;
  /** Log lines are stored with the execution in Chronos. */
  log: TaskLogger;
}

export type TaskHandler<TPayload = unknown> = (context: TaskContext<TPayload>) => unknown;

export type ChronosStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'stopping' | 'stopped';

interface RegisteredTask {
  definition: AgentTaskDefinition;
  handler: TaskHandler<unknown>;
}

interface RunningExecution {
  attempt: number;
  controller: AbortController;
  done: Promise<void>;
}

class AbortReason extends Error {
  constructor(readonly kind: 'timeout' | 'cancel' | 'shutdown', message: string) {
    super(message);
  }
}

const MAX_OUTPUT_BYTES = 64 * 1024;

function defaultLogger(): ChronosLogger {
  const debug = process.env.CHRONOS_DEBUG === '1';
  return {
    debug: (message, ...args) => (debug ? console.debug(`[chronos] ${message}`, ...args) : undefined),
    info: (message, ...args) => console.info(`[chronos] ${message}`, ...args),
    warn: (message, ...args) => console.warn(`[chronos] ${message}`, ...args),
    error: (message, ...args) => console.error(`[chronos] ${message}`, ...args),
  };
}

const noopLogger: ChronosLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

/**
 * The Chronos agent. Create one shared instance per application, register tasks from
 * any module with `task()`, then call `start()` once.
 *
 * Delivery is at-least-once: a handler can run more than once for the same execution
 * (for example after a network partition). Use `context.idempotencyKey` to make side
 * effects idempotent.
 */
export class Chronos extends EventEmitter {
  private readonly options: Required<Pick<ChronosOptions, 'server' | 'project' | 'concurrency' | 'shutdownTimeoutMs'>> & ChronosOptions;
  private readonly logger: ChronosLogger;
  private readonly tasks = new Map<string, RegisteredTask>();
  private readonly running = new Map<string, RunningExecution>();
  /** Results not yet acknowledged by the server; re-sent after every reconnect. */
  private readonly unacked = new Map<string, ResultMessage>();
  private socket?: WebSocket;
  private welcomed = false;
  private state: ChronosStatus = 'idle';
  private reconnectAttempt = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private heartbeatIntervalMs = 10_000;
  private missedPongs = 0;
  private startPromise?: Promise<void>;
  private settleStart?: { resolve: () => void; reject: (error: Error) => void };
  private readonly instanceId: string;
  private readonly submissions: SubmissionClient;
  agentId?: string;

  constructor(options: ChronosOptions) {
    super();
    if (!options || typeof options.server !== 'string' || options.server.length === 0) throw new ChronosConfigError('"server" is required');
    if (typeof options.project !== 'string' || options.project.length === 0) throw new ChronosConfigError('"project" is required');
    agentSocketUrl(options.server, AGENT_WS_PATH); // validates the URL early
    const concurrency = options.concurrency ?? 5;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 1000) throw new ChronosConfigError('"concurrency" must be an integer between 1 and 1000');
    this.options = { ...options, concurrency, shutdownTimeoutMs: options.shutdownTimeoutMs ?? 30_000 };
    this.logger = options.logger === false ? noopLogger : (options.logger ?? defaultLogger());
    this.instanceId = options.instanceId ?? randomUUID();
    const http = new HttpClient({
      server: options.server,
      token: () => this.options.token ?? process.env.CHRONOS_AGENT_TOKEN,
      missingTokenMessage: 'An agent token is required: pass "token" or set CHRONOS_AGENT_TOKEN',
      userAgent: `chronos-sdk-node/${SDK_VERSION}`,
    });
    this.submissions = new SubmissionClient(http, projectIdResolver(http, options.project, '/v1/agent/identity'));
  }

  /**
   * Submits a job for asynchronous execution: immediately, or after `options.delay` ms /
   * at `options.runAt`. `job` is a job NAME (a task registered by any application of the
   * project, or a job created through the API); it can run in any mode (agent, worker,
   * webhook). Works without start(): only the server URL and the token are needed.
   *
   * Transient failures are retried with the same idempotency key, so one call creates at
   * most one execution.
   *
   * @example await chronos.queue('send-email', { to: 'a@example.com' });
   * @example await chronos.queue('send-reminder', payload, { delay: 300_000 });
   */
  queue<TPayload = unknown>(job: string, payload?: TPayload, options?: QueueOptions): Promise<QueuedExecution> {
    return this.submissions.queue(job, payload, options);
  }

  /**
   * Cancels an execution that has not started yet (pending, delayed, queued or waiting
   * for a retry). Resolves false if it already started or finished.
   */
  cancel(executionId: string): Promise<boolean> {
    return this.submissions.cancel(executionId);
  }

  /**
   * An admin client for the same server and project. Agent tokens cannot manage jobs, so
   * pass a project API key (or set CHRONOS_API_KEY).
   *
   * @example const admin = chronos.admin({ token: process.env.CHRONOS_API_KEY });
   */
  admin(options: { token?: string; maxAttempts?: number; requestTimeoutMs?: number } = {}): ChronosAdmin {
    return new ChronosAdmin({ server: this.options.server, project: this.options.project, ...options });
  }

  get status(): ChronosStatus {
    return this.state;
  }

  /** Names of registered tasks. */
  get taskNames(): string[] {
    return [...this.tasks.keys()];
  }

  /** Registers a handler. Must be called before start(). */
  task<TPayload = unknown>(name: string, handler: TaskHandler<TPayload>): this;
  task<TPayload = unknown>(name: string, options: TaskOptions, handler: TaskHandler<TPayload>): this;
  task<TPayload = unknown>(name: string, optionsOrHandler: TaskOptions | TaskHandler<TPayload>, maybeHandler?: TaskHandler<TPayload>): this {
    const options: TaskOptions = typeof optionsOrHandler === 'function' ? {} : optionsOrHandler;
    const handler = typeof optionsOrHandler === 'function' ? optionsOrHandler : maybeHandler;
    if (this.state !== 'idle') throw new ChronosConfigError(`Cannot register task "${name}" after start(); register all tasks before starting`);
    if (typeof handler !== 'function') throw new ChronosConfigError(`Task "${name}" needs a handler function`);
    if (this.tasks.has(name)) throw new ChronosConfigError(`Task "${name}" is already registered`);
    if (options.schedule !== undefined && options.runAt !== undefined) throw new ChronosConfigError(`Task "${name}": use either "schedule" or "runAt", not both`);

    const hasSchedule = options.schedule !== undefined || options.runAt !== undefined;
    const input: AgentTaskDefinitionInput = {
      name,
      ...(options.description !== undefined ? { description: options.description } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
      ...(options.retryBackoffMs !== undefined ? { retryBackoffMs: options.retryBackoffMs } : {}),
      ...(options.retryBackoffMaxMs !== undefined ? { retryBackoffMaxMs: options.retryBackoffMaxMs } : {}),
      ...(options.concurrencyPolicy !== undefined ? { concurrencyPolicy: options.concurrencyPolicy } : {}),
      ...(options.queue !== undefined ? { queue: options.queue } : {}),
      ...(options.priority !== undefined ? { priority: options.priority } : {}),
      ...(options.maxConcurrency !== undefined ? { maxConcurrency: options.maxConcurrency } : {}),
      ...(options.payloadSchema !== undefined ? { payloadSchema: options.payloadSchema } : {}),
      schedule: hasSchedule
        ? {
            ...(options.schedule !== undefined ? { cron: options.schedule } : {}),
            ...(options.runAt !== undefined ? { runAt: new Date(options.runAt) } : {}),
            ...((options.timezone ?? this.options.timezone) ? { timezone: options.timezone ?? this.options.timezone } : {}),
            ...(options.misfirePolicy !== undefined ? { misfirePolicy: options.misfirePolicy } : {}),
            ...(options.misfireGraceMs !== undefined ? { misfireGraceMs: options.misfireGraceMs } : {}),
            ...(options.maxCatchUp !== undefined ? { maxCatchUp: options.maxCatchUp } : {}),
          }
        : null,
    };
    const parsed = agentTaskDefinitionSchema.safeParse(input);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'task'}: ${issue.message}`).join('; ');
      throw new ChronosConfigError(`Invalid task "${name}": ${issues}`);
    }
    this.tasks.set(name, { definition: parsed.data, handler: handler as TaskHandler<unknown> });
    return this;
  }

  /**
   * Connects, synchronises the registered tasks and starts receiving executions.
   * Resolves on the first successful handshake. Rejects on unrecoverable errors (bad
   * token, project mismatch, invalid tasks); transient network errors are retried with
   * exponential backoff while start() keeps waiting.
   */
  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.state !== 'idle') return Promise.reject(new ChronosConfigError(`Cannot start: SDK is ${this.state}`));
    const token = this.options.token ?? process.env.CHRONOS_AGENT_TOKEN;
    if (!token) return Promise.reject(new ChronosConfigError('An agent token is required: pass "token" or set CHRONOS_AGENT_TOKEN'));
    if (this.tasks.size === 0) this.logger.warn('Starting with no registered tasks');
    this.options.token = token;
    this.state = 'connecting';
    this.startPromise = new Promise<void>((resolve, reject) => {
      this.settleStart = { resolve, reject };
    });
    this.connect();
    return this.startPromise;
  }

  private connect(): void {
    const url = agentSocketUrl(this.options.server, AGENT_WS_PATH);
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.options.token}`, 'User-Agent': `chronos-sdk-node/${SDK_VERSION}` },
      handshakeTimeout: 15_000,
      maxPayload: MAX_FRAME_BYTES,
    });
    this.socket = socket;
    this.welcomed = false;

    socket.on('open', () => this.sendHello(socket));
    socket.on('message', (data: RawData) => this.onFrame(socket, data));
    socket.on('pong', () => {
      this.missedPongs = 0;
    });
    socket.on('unexpected-response', (request, response) => {
      // The upgrade was refused with an HTTP status (401 bad token, 503 shutting down...).
      const status = response.statusCode ?? 0;
      request.destroy();
      const fatal = status === 401 || status === 403 || status === 404;
      this.onDisconnect(
        socket,
        fatal ? CloseCode.UNAUTHORIZED : 1006,
        status === 401 ? 'authentication failed: invalid, revoked or expired agent token' : `server responded ${status} to the WebSocket upgrade`,
        fatal,
      );
    });
    socket.on('error', (error: Error) => this.logger.debug(`socket error: ${error.message}`));
    socket.on('close', (code: number, reason: Buffer) => this.onDisconnect(socket, code, reason.toString()));
  }

  private sendHello(socket: WebSocket): void {
    this.send(socket, {
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      sdkVersion: SDK_VERSION,
      instanceId: this.instanceId,
      project: this.options.project,
      hostname: this.options.hostname ?? osHostname(),
      concurrency: this.options.concurrency,
      tasks: [...this.tasks.values()].map((task) => task.definition),
    });
  }

  private send(socket: WebSocket | undefined, message: unknown): boolean {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  private onFrame(socket: WebSocket, data: RawData): void {
    let message: ServerMessage;
    try {
      message = serverMessageSchema.parse(JSON.parse(data.toString()));
    } catch (error) {
      this.logger.warn(`Ignoring malformed server frame: ${String(error)}`);
      return;
    }
    switch (message.type) {
      case 'welcome':
        return this.onWelcome(socket, message);
      case 'execute':
        return this.onExecute(socket, message);
      case 'cancel': {
        const entry = this.running.get(message.executionId);
        if (entry && entry.attempt === message.attempt) {
          this.logger.info(`Execution ${message.executionId} cancelled: ${message.reason}`);
          entry.controller.abort(new AbortReason('cancel', message.reason));
        }
        return;
      }
      case 'result_ack': {
        const key = resultKey(message.executionId, message.attempt);
        const wasPending = this.unacked.delete(key);
        if (wasPending && !message.accepted) {
          this.logger.warn(`Result for execution ${message.executionId} was discarded (cancelled, timed out or re-assigned)`);
        }
        if (this.unacked.size === 0) this.emit('drained');
        return;
      }
      case 'error':
        this.logger.error(`Server error ${message.code}: ${message.message}`);
        return;
    }
  }

  private onWelcome(socket: WebSocket, message: Extract<ServerMessage, { type: 'welcome' }>): void {
    this.welcomed = true;
    this.agentId = message.agentId;
    this.heartbeatIntervalMs = message.heartbeatIntervalMs;
    this.reconnectAttempt = 0;
    if (this.state === 'connecting' || this.state === 'reconnecting') this.state = 'connected';

    for (const task of message.tasks) {
      if (task.managedBy === 'api') {
        this.logger.warn(`Task "${task.name}" is managed through the Chronos API; its schedule and settings there take precedence over code`);
      }
    }
    this.startHeartbeat(socket);
    // Renew leases of executions that kept running through a reconnect, then re-send
    // results the server has not acknowledged (they may have been lost in flight).
    this.sendHeartbeat(socket);
    for (const result of this.unacked.values()) this.send(socket, result);

    this.logger.info(`Connected as agent ${message.agentId} with ${message.tasks.length} task(s)`);
    this.emit('connected', { agentId: message.agentId, tasks: message.tasks });
    this.settleStart?.resolve();
    this.settleStart = undefined;
  }

  private startHeartbeat(socket: WebSocket): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.missedPongs = 0;
    this.heartbeatTimer = setInterval(() => {
      if (socket !== this.socket) return;
      // Detect half-open connections (e.g. a NAT dropped the mapping silently).
      if (this.missedPongs >= 2) {
        this.logger.warn('Server stopped responding; reconnecting');
        socket.terminate();
        return;
      }
      this.missedPongs += 1;
      socket.ping();
      this.sendHeartbeat(socket);
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }

  private sendHeartbeat(socket: WebSocket): void {
    this.send(socket, {
      type: 'heartbeat',
      running: [...this.running.entries()].map(([executionId, entry]) => ({ executionId, attempt: entry.attempt })),
    });
  }

  private onExecute(socket: WebSocket, message: ExecuteMessage): void {
    const existing = this.running.get(message.executionId);
    if (existing && existing.attempt === message.attempt) {
      this.send(socket, { type: 'ack', executionId: message.executionId, attempt: message.attempt });
      return;
    }
    const task = this.tasks.get(message.task);
    if (!task) {
      this.sendResult({
        type: 'result',
        executionId: message.executionId,
        attempt: message.attempt,
        status: 'failed',
        error: { message: `No handler registered for task "${message.task}" in this process`, code: 'NO_HANDLER', retryable: true, timedOut: false },
      });
      return;
    }
    this.send(socket, { type: 'ack', executionId: message.executionId, attempt: message.attempt });
    this.run(task, message);
  }

  private run(task: RegisteredTask, message: ExecuteMessage): void {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new AbortReason('timeout', `Task exceeded its timeout of ${message.timeoutMs}ms`)),
      message.timeoutMs,
    );
    const ref = { executionId: message.executionId, attempt: message.attempt };
    const log = (level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR') => (text: string, data?: unknown) => {
      this.logger.debug(`[${message.task}] ${text}`);
      this.send(this.welcomed ? this.socket : undefined, { type: 'log', ...ref, level, message: String(text).slice(0, 4000), ...(data !== undefined ? { data: safeJson(data) } : {}) });
    };
    const context: TaskContext<unknown> = {
      executionId: message.executionId,
      attempt: message.attempt,
      task: message.task,
      scheduledFor: new Date(message.scheduledFor),
      idempotencyKey: message.idempotencyKey,
      payload: message.payload,
      signal: controller.signal,
      log: { debug: log('DEBUG'), info: log('INFO'), warn: log('WARN'), error: log('ERROR') },
    };

    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });

    const done = (async () => {
      try {
        const output = await Promise.race([Promise.resolve().then(() => task.handler(context)), aborted]);
        const serialised = serialiseOutput(output);
        this.sendResult({ type: 'result', ...ref, status: 'succeeded', ...(serialised !== undefined ? { output: serialised } : {}) });
      } catch (error) {
        const reason = controller.signal.aborted ? controller.signal.reason : undefined;
        if (reason instanceof AbortReason && reason.kind === 'cancel') return; // the server already finalised it
        const timedOut = reason instanceof AbortReason && reason.kind === 'timeout';
        const failure = reason instanceof AbortReason ? reason : error;
        this.sendResult({
          type: 'result',
          ...ref,
          status: 'failed',
          error: {
            message: failure instanceof Error ? failure.message.slice(0, 4000) : String(failure).slice(0, 4000),
            ...(failure instanceof NonRetryableError && failure.code ? { code: failure.code } : timedOut ? { code: 'TIMEOUT' } : {}),
            retryable: !(failure instanceof NonRetryableError),
            timedOut,
          },
        });
      } finally {
        clearTimeout(timeout);
        this.running.delete(message.executionId);
      }
    })();
    this.running.set(message.executionId, { attempt: message.attempt, controller, done });
  }

  /**
   * Results are kept until the server acknowledges them, and re-sent after reconnects.
   * The execution's lease keeps it assigned to this agent in the meantime. A duplicate
   * delivery is harmless: the server accepts only the first result for an attempt.
   */
  private sendResult(result: ResultMessage): void {
    this.unacked.set(resultKey(result.executionId, result.attempt), result);
    if (this.welcomed) this.send(this.socket, result);
  }

  private waitForAcks(timeoutMs: number): Promise<void> {
    if (this.unacked.size === 0 || !this.welcomed) return Promise.resolve();
    return new Promise((resolve) => {
      const wait: { timer?: NodeJS.Timeout } = {};
      const done = () => {
        clearTimeout(wait.timer);
        this.off('drained', done);
        resolve();
      };
      wait.timer = setTimeout(done, timeoutMs);
      this.once('drained', done);
    });
  }

  private onDisconnect(socket: WebSocket, code: number, reason: string, forceFatal = false): void {
    if (socket !== this.socket) return;
    this.socket = undefined;
    this.welcomed = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    if (this.state === 'stopping' || this.state === 'stopped') return;

    if (forceFatal || FATAL_CLOSE_CODES.has(code)) {
      const error = new ChronosConnectionError(`Chronos rejected this agent: ${reason || `close code ${code}`}`, code, true);
      this.logger.error(error.message);
      this.state = 'stopped';
      for (const entry of this.running.values()) entry.controller.abort(new AbortReason('shutdown', 'agent rejected by server'));
      if (this.settleStart) {
        this.settleStart.reject(error);
        this.settleStart = undefined;
      } else if (this.listenerCount('error') > 0) {
        this.emit('error', error);
      }
      return;
    }

    this.state = this.state === 'connecting' ? 'connecting' : 'reconnecting';
    const delay = reconnectDelay(this.reconnectAttempt, this.options.reconnect?.initialDelayMs ?? 500, this.options.reconnect?.maxDelayMs ?? 30_000);
    this.reconnectAttempt += 1;
    this.logger.warn(`Disconnected from Chronos (${code}${reason ? `: ${reason}` : ''}); reconnecting in ${delay}ms`);
    this.emit('disconnected', { code, reason });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.state === 'reconnecting' || this.state === 'connecting') this.connect();
    }, delay);
  }

  /**
   * Graceful shutdown: stop accepting work, wait for running handlers (up to
   * shutdownTimeoutMs, then abort them), deliver their results, and disconnect.
   */
  async stop(options: { timeoutMs?: number } = {}): Promise<void> {
    if (this.state === 'idle' || this.state === 'stopped') {
      this.state = 'stopped';
      return;
    }
    if (this.state === 'stopping') return;
    const wasWelcomed = this.welcomed;
    this.state = 'stopping';
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.send(wasWelcomed ? this.socket : undefined, { type: 'goodbye', reason: 'shutdown' });

    const timeoutMs = options.timeoutMs ?? this.options.shutdownTimeoutMs;
    const allDone = Promise.allSettled([...this.running.values()].map((entry) => entry.done));
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      allDone.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut) {
      this.logger.warn(`Aborting ${this.running.size} handler(s) still running after ${timeoutMs}ms`);
      for (const entry of this.running.values()) entry.controller.abort(new AbortReason('shutdown', 'agent shutting down'));
      await Promise.allSettled([...this.running.values()].map((entry) => entry.done));
    }

    // Give the server a moment to acknowledge the final results before disconnecting.
    await this.waitForAcks(5000);
    const socket = this.socket;
    if (socket && socket.readyState === WebSocket.OPEN) {
      await new Promise<void>((resolve) => {
        socket.once('close', () => resolve());
        socket.close(CloseCode.NORMAL, 'agent stopped');
        setTimeout(resolve, 2000).unref();
      });
    } else {
      socket?.terminate();
    }
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.socket = undefined;
    this.state = 'stopped';
    if (this.settleStart) {
      this.settleStart.reject(new ChronosConfigError('stop() was called before the connection was established'));
      this.settleStart = undefined;
    }
    if (this.unacked.size > 0) {
      this.logger.warn(`${this.unacked.size} result(s) were not acknowledged before shutdown; Chronos will retry those executions`);
    }
    this.emit('stopped');
  }
}

function resultKey(executionId: string, attempt: number): string {
  return `${executionId}:${attempt}`;
}

function safeJson(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
}

function serialiseOutput(output: unknown): unknown {
  if (output === undefined) return undefined;
  let text: string | undefined;
  try {
    text = JSON.stringify(output);
  } catch {
    return { unserialisable: true, type: typeof output };
  }
  if (text === undefined) return undefined;
  if (Buffer.byteLength(text, 'utf8') > MAX_OUTPUT_BYTES) return { truncated: true, bytes: Buffer.byteLength(text, 'utf8') };
  return JSON.parse(text) as unknown;
}
