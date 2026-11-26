import { Logger } from '@nestjs/common';
import type { WebSocket, RawData } from 'ws';
import { Prisma } from '@chronos/database';
import { ExecutionStore, dbNow, leaseOwnerOf, syncAgentTasks } from '@chronos/engine';
import {
  CloseCode,
  HelloMessage,
  PROTOCOL_VERSION,
  ServerMessage,
  SUPPORTED_PROTOCOL_VERSIONS,
  clientMessageSchema,
} from '@chronos/protocol';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { AgentWorkSignal } from '../../infrastructure/engine/agent-work-signal';

export interface AgentSessionDeps {
  prisma: PrismaService;
  store: ExecutionStore;
  workSignal: AgentWorkSignal;
  heartbeatIntervalMs: number;
  leaseMs: number;
  /** Re-checks the credential the connection authenticated with (revocation, expiry, archiving). */
  isCredentialActive: () => Promise<boolean>;
  /** Minimum interval between credential re-checks. */
  credentialCheckIntervalMs: number;
  /** Called once the session has ended so the gateway can forget it. */
  onClosed: (session: AgentSession) => void;
  /** Called after a successful hello; returns a session this one supersedes, if any. */
  onRegistered: (session: AgentSession) => void;
}

export interface AgentIdentity {
  projectId: string;
  organizationId: string;
  credentialId: string;
}

const HANDSHAKE_TIMEOUT_MS = 10_000;
const ACK_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 5_000;

interface Inflight {
  attempt: number;
  ackTimer?: NodeJS.Timeout;
}

/**
 * One connected SDK process. Work is *pulled* from PostgreSQL by this session (claim
 * with SKIP LOCKED) up to the agent's declared concurrency, so several replicas and
 * several agents of the same project share work without coordination beyond the
 * database. Redis wake-ups and a periodic poll trigger the pulls.
 */
export class AgentSession {
  private readonly logger = new Logger(AgentSession.name);
  agentId?: string;
  instanceId?: string;
  owner?: string;
  private hello?: HelloMessage;
  private taskNames: string[] = [];
  private connectedAt?: Date;
  private readonly inflight = new Map<string, Inflight>();
  private draining = false;
  private closed = false;
  private pumping = false;
  private pumpAgain = false;
  private timers: NodeJS.Timeout[] = [];
  private lastHeartbeat = Date.now();
  private lastCredentialCheck = Date.now();
  /** The agent-row status write in flight; onClose awaits it so OFFLINE is always written last. */
  private statusWrite: Promise<unknown> = Promise.resolve();
  private unsubscribe?: () => void;

  constructor(
    private readonly socket: WebSocket,
    readonly identity: AgentIdentity,
    private readonly deps: AgentSessionDeps,
  ) {
    const handshake = setTimeout(() => this.close(CloseCode.HANDSHAKE_TIMEOUT, 'hello not received in time'), HANDSHAKE_TIMEOUT_MS);
    this.timers.push(handshake);
    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) return this.close(CloseCode.PROTOCOL_ERROR, 'binary frames are not supported');
      void this.onMessage(data.toString()).catch((error: unknown) => {
        this.logger.error({ agentId: this.agentId, err: String(error) }, 'Agent message handling failed');
      });
    });
    socket.on('close', () => void this.onClose());
    socket.on('error', (error: Error) => this.logger.warn({ agentId: this.agentId, err: error.message }, 'Agent socket error'));
  }

  get isRegistered(): boolean {
    return this.agentId !== undefined;
  }

  private send(message: ServerMessage): void {
    if (this.socket.readyState === this.socket.OPEN) this.socket.send(JSON.stringify(message));
  }

  close(code: number, reason: string): void {
    if (this.socket.readyState === this.socket.OPEN || this.socket.readyState === this.socket.CONNECTING) {
      this.socket.close(code, reason.slice(0, 120));
    }
  }

  private fail(code: number, errorCode: string, message: string): void {
    this.send({ type: 'error', code: errorCode, message });
    this.close(code, message);
  }

  private async onMessage(raw: string): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return this.fail(CloseCode.PROTOCOL_ERROR, 'MALFORMED_FRAME', 'frame is not valid JSON');
    }
    const parsed = clientMessageSchema.safeParse(json);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const detail = first ? `${first.path.join('.')}: ${first.message}` : 'invalid frame';
      return this.fail(
        this.hello ? CloseCode.PROTOCOL_ERROR : CloseCode.INVALID_REGISTRATION,
        'INVALID_MESSAGE',
        `invalid ${(json as { type?: string })?.type ?? 'unknown'} message (${detail})`,
      );
    }
    const message = parsed.data;
    if (message.type === 'hello') return this.onHello(message);
    if (!this.hello || !this.owner) return this.fail(CloseCode.PROTOCOL_ERROR, 'NOT_REGISTERED', 'send hello first');

    switch (message.type) {
      case 'heartbeat':
        return this.onHeartbeat(message.running);
      case 'ack': {
        const entry = this.inflight.get(message.executionId);
        if (entry?.ackTimer) clearTimeout(entry.ackTimer);
        if (entry) entry.ackTimer = undefined;
        return;
      }
      case 'log':
        await this.deps.store.appendLog(
          { executionId: message.executionId, attempt: message.attempt, owner: this.owner },
          message.level,
          message.message,
          message.data === undefined ? undefined : (message.data as Prisma.InputJsonValue),
        );
        return;
      case 'result':
        return this.onResult(message);
      case 'goodbye':
        this.draining = true;
        if (this.closed) return;
        this.statusWrite = this.deps.prisma.agent.update({ where: { id: this.agentId! }, data: { status: 'DRAINING' } }).catch(() => undefined);
        await this.statusWrite;
        return;
    }
  }

  private async onHello(hello: HelloMessage): Promise<void> {
    if (this.hello) return this.fail(CloseCode.PROTOCOL_ERROR, 'DUPLICATE_HELLO', 'hello already received');
    if (!(SUPPORTED_PROTOCOL_VERSIONS as readonly number[]).includes(hello.protocolVersion)) {
      return this.fail(
        CloseCode.UNSUPPORTED_VERSION,
        'UNSUPPORTED_PROTOCOL',
        `protocol version ${hello.protocolVersion} is not supported (server supports ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')})`,
      );
    }
    const names = hello.tasks.map((task) => task.name);
    if (new Set(names).size !== names.length) {
      return this.fail(CloseCode.INVALID_REGISTRATION, 'DUPLICATE_TASK', 'task names must be unique');
    }
    for (const task of hello.tasks) {
      const problem = task.payloadSchema ? this.deps.store.payloadValidator.checkSchema(task.payloadSchema) : null;
      if (problem) return this.fail(CloseCode.INVALID_REGISTRATION, 'INVALID_PAYLOAD_SCHEMA', `task "${task.name}": ${problem}`);
    }

    const project = await this.deps.prisma.project.findUnique({ where: { id: this.identity.projectId }, select: { slug: true, timezone: true } });
    if (!project) return this.fail(CloseCode.UNAUTHORIZED, 'UNAUTHORIZED', 'project not found');
    if (project.slug !== hello.project) {
      return this.fail(
        CloseCode.INVALID_REGISTRATION,
        'PROJECT_MISMATCH',
        `this agent token belongs to project "${project.slug}", but the SDK is configured for "${hello.project}"`,
      );
    }

    const { agent, synced } = await this.deps.prisma.$transaction(
      async (tx) => {
        const now = await dbNow(tx);
        const synced = await syncAgentTasks(tx, this.identity.projectId, project.timezone, hello.tasks, now);
        const fields = {
          credentialId: this.identity.credentialId,
          hostname: hello.hostname ?? null,
          sdkVersion: hello.sdkVersion,
          protocolVersion: hello.protocolVersion,
          status: 'ONLINE' as const,
          handlers: names,
          connectedAt: now,
          lastHeartbeatAt: now,
          disconnectedAt: null,
        };
        const agent = await tx.agent.upsert({
          where: { projectId_instanceId: { projectId: this.identity.projectId, instanceId: hello.instanceId } },
          create: { ...fields, projectId: this.identity.projectId, instanceId: hello.instanceId },
          update: fields,
        });
        return { agent, synced };
      },
      { timeout: 30_000, maxWait: 10_000 },
    );

    this.hello = hello;
    this.agentId = agent.id;
    this.instanceId = hello.instanceId;
    this.connectedAt = agent.connectedAt;
    this.owner = leaseOwnerOf({ kind: 'agent', agentId: agent.id });
    this.taskNames = names;
    clearTimeout(this.timers.shift());
    this.deps.onRegistered(this);

    this.send({
      type: 'welcome',
      protocolVersion: PROTOCOL_VERSION,
      agentId: agent.id,
      heartbeatIntervalMs: this.deps.heartbeatIntervalMs,
      tasks: synced,
    });
    this.logger.log({ agentId: agent.id, projectId: this.identity.projectId, tasks: names.length, hostname: hello.hostname }, 'Agent connected');

    this.unsubscribe = this.deps.workSignal.subscribe(this.identity.projectId, () => void this.pump());
    this.timers.push(setInterval(() => void this.pump(), POLL_INTERVAL_MS));
    this.timers.push(
      setInterval(() => {
        // Half-open connection detection: the SDK heartbeats every interval.
        if (Date.now() - this.lastHeartbeat > this.deps.heartbeatIntervalMs * 3) {
          this.logger.warn({ agentId: this.agentId }, 'Agent heartbeat missed; terminating connection');
          this.socket.terminate();
        }
      }, this.deps.heartbeatIntervalMs),
    );
    void this.pump();
  }

  /**
   * The token was checked once at upgrade time. Re-check it periodically so that revoking
   * a credential, letting a rotated one expire, or archiving the project disconnects
   * agents that are already connected instead of letting them keep claiming work.
   */
  private async credentialStillValid(): Promise<boolean> {
    if (Date.now() - this.lastCredentialCheck < this.deps.credentialCheckIntervalMs) return true;
    this.lastCredentialCheck = Date.now();
    const active = await this.deps.isCredentialActive().catch(() => true); // DB hiccup: fail open until the next check
    if (active) return true;
    this.logger.warn({ agentId: this.agentId, credentialId: this.identity.credentialId }, 'Agent credential revoked or expired; disconnecting');
    this.draining = true;
    this.fail(CloseCode.UNAUTHORIZED, 'CREDENTIAL_REVOKED', 'agent token was revoked or has expired');
    return false;
  }

  private async onHeartbeat(running: { executionId: string; attempt: number }[]): Promise<void> {
    this.lastHeartbeat = Date.now();
    if (!(await this.credentialStillValid())) return;
    // Adopt executions started before a reconnect (possibly via another replica).
    for (const ref of running) if (!this.inflight.has(ref.executionId)) this.inflight.set(ref.executionId, { attempt: ref.attempt });

    const held = await this.deps.store.renewLeases(this.owner!, running, this.deps.leaseMs);
    for (const ref of running) {
      if (!held.has(ref.executionId)) {
        // Cancelled or reaped server-side: tell the agent to stop, stop counting it.
        this.send({ type: 'cancel', executionId: ref.executionId, attempt: ref.attempt, reason: 'execution is no longer assigned to this agent' });
        this.forget(ref.executionId);
      }
    }
    // The socket may have closed while leases were renewed: never revive a closed session's row.
    if (this.closed) return;
    this.statusWrite = this.deps.prisma.agent
      .update({ where: { id: this.agentId! }, data: { lastHeartbeatAt: new Date(), ...(this.draining ? {} : { status: 'ONLINE' }) } })
      .catch(() => undefined);
    await this.statusWrite;
    void this.pump();
  }

  private async onResult(message: Extract<import('@chronos/protocol').ClientMessage, { type: 'result' }>): Promise<void> {
    const ref = { executionId: message.executionId, attempt: message.attempt, owner: this.owner! };
    let accepted: boolean;
    if (message.status === 'succeeded') {
      accepted = await this.deps.store.complete(ref, message.output === undefined ? {} : { output: message.output as Prisma.InputJsonValue });
    } else {
      const status = await this.deps.store.fail(ref, {
        message: message.error.message,
        ...(message.error.code ? { code: message.error.code } : {}),
        retryable: message.error.retryable,
        timedOut: message.error.timedOut,
      });
      accepted = status !== null;
    }
    this.forget(message.executionId);
    this.send({ type: 'result_ack', executionId: message.executionId, attempt: message.attempt, accepted });
    void this.pump();
  }

  private forget(executionId: string): void {
    const entry = this.inflight.get(executionId);
    if (entry?.ackTimer) clearTimeout(entry.ackTimer);
    this.inflight.delete(executionId);
  }

  /** Delivers a cancellation for an execution this session is running. */
  cancel(executionId: string, attempt: number, reason: string): boolean {
    if (!this.inflight.has(executionId)) return false;
    this.send({ type: 'cancel', executionId, attempt, reason });
    this.forget(executionId);
    return true;
  }

  /** Claims and sends as much work as the agent's free capacity allows. */
  async pump(): Promise<void> {
    if (this.closed || this.draining || !this.hello || !this.agentId) return;
    if (!(await this.credentialStillValid())) return;
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        const capacity = this.hello.concurrency - this.inflight.size;
        if (capacity <= 0) break;
        const claimed = await this.deps.store.claimForAgent(this.identity.projectId, this.agentId, this.taskNames, capacity, this.deps.leaseMs);
        for (const execution of claimed) {
          if (this.closed) break; // lease expiry will return the claim to the pool
          const entry: Inflight = { attempt: execution.attempt };
          entry.ackTimer = setTimeout(() => void this.onAckTimeout(execution.executionId, execution.attempt), ACK_TIMEOUT_MS);
          this.inflight.set(execution.executionId, entry);
          this.send({
            type: 'execute',
            executionId: execution.executionId,
            attempt: execution.attempt,
            task: execution.jobName,
            idempotencyKey: execution.idempotencyKey,
            scheduledFor: execution.scheduledFor.toISOString(),
            payload: execution.payload ?? undefined,
            timeoutMs: execution.timeoutMs,
          });
        }
        if (claimed.length === capacity) this.pumpAgain = true;
      } while (this.pumpAgain && !this.closed);
    } catch (error) {
      this.logger.warn({ agentId: this.agentId, err: String(error) }, 'Claiming agent work failed; will retry');
    } finally {
      this.pumping = false;
    }
  }

  private async onAckTimeout(executionId: string, attempt: number): Promise<void> {
    if (!this.inflight.has(executionId)) return;
    this.forget(executionId);
    await this.deps.store.fail(
      { executionId, attempt, owner: this.owner! },
      { message: 'Agent did not acknowledge the execution', code: 'NO_ACK', retryable: true, abandoned: true },
    );
  }

  private async onClose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    this.unsubscribe?.();
    for (const entry of this.inflight.values()) if (entry.ackTimer) clearTimeout(entry.ackTimer);
    // In-flight executions are NOT failed here: the agent may reconnect (to any replica)
    // and keep renewing their leases. If it does not, the reaper retries them.
    this.inflight.clear();
    if (this.agentId && this.connectedAt) {
      // A heartbeat or goodbye write that started before the close must land first.
      await this.statusWrite;
      // Only mark offline if no newer session of the same instance took over meanwhile.
      await this.deps.prisma.agent
        .updateMany({ where: { id: this.agentId, connectedAt: this.connectedAt }, data: { status: 'OFFLINE', disconnectedAt: new Date() } })
        .catch(() => undefined);
      this.logger.log({ agentId: this.agentId }, 'Agent disconnected');
    }
    this.deps.onClosed(this);
  }
}
