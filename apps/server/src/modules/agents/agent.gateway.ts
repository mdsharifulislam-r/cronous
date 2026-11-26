import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { WebSocketServer } from 'ws';
import { ExecutionStore } from '@chronos/engine';
import { AGENT_WS_PATH, CloseCode, MAX_FRAME_BYTES } from '@chronos/protocol';
import { APP_CONFIG } from '../../config/config.module';
import { ServerEnv } from '../../config/env.schema';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AgentWorkSignal, CancelSignal } from '../../infrastructure/engine/agent-work-signal';
import { CredentialsService } from '../auth/credentials.service';
import { extractBearerToken } from '../auth/auth.guard';
import { AgentSession } from './agent-session';

/**
 * WebSocket gateway for SDK agents (Mode B). Applications connect outbound, so they
 * never need a public inbound port. Authentication happens during the HTTP upgrade, so
 * unauthenticated clients never get a WebSocket.
 */
@Injectable()
export class AgentGateway implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AgentGateway.name);
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  private readonly sessions = new Set<AgentSession>();
  private unsubscribeCancel?: () => void;
  private accepting = true;
  private readonly upgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => void this.onUpgrade(request, socket, head);

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly credentials: CredentialsService,
    private readonly prisma: PrismaService,
    private readonly store: ExecutionStore,
    private readonly workSignal: AgentWorkSignal,
    private readonly cancelSignal: CancelSignal,
    @Inject(APP_CONFIG) private readonly config: ServerEnv,
  ) {}

  onApplicationBootstrap(): void {
    this.adapterHost.httpAdapter.getHttpServer().on('upgrade', this.upgradeHandler);
    this.unsubscribeCancel = this.cancelSignal.subscribe((notice) => {
      for (const session of this.sessions) {
        if (session.owner === notice.owner) session.cancel(notice.executionId, notice.attempt, 'cancelled by user');
      }
    });
  }

  get connectedCount(): number {
    return this.sessions.size;
  }

  private reject(socket: Duplex, status: number, message: string): void {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }

  private async onUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path !== AGENT_WS_PATH) return this.reject(socket, 404, 'Not Found');
    if (!this.accepting) return this.reject(socket, 503, 'Service Unavailable');

    const token = extractBearerToken(request.headers.authorization);
    const principal = token ? await this.credentials.resolve(token).catch(() => null) : null;
    if (!principal || principal.type !== 'agent') return this.reject(socket, 401, 'Unauthorized');

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      const session = new AgentSession(
        ws,
        { projectId: principal.projectId, organizationId: principal.organizationId, credentialId: principal.credentialId },
        {
          prisma: this.prisma,
          store: this.store,
          workSignal: this.workSignal,
          heartbeatIntervalMs: this.config.CHRONOS_AGENT_HEARTBEAT_MS,
          leaseMs: this.config.CHRONOS_LEASE_MS,
          isCredentialActive: () => this.credentials.isActive(principal.credentialId),
          credentialCheckIntervalMs: this.config.CHRONOS_CREDENTIAL_RECHECK_MS,
          onClosed: (closed) => this.sessions.delete(closed),
          onRegistered: (registered) => {
            // A process that reconnects before its old socket timed out replaces it.
            for (const other of this.sessions) {
              if (other !== registered && other.instanceId === registered.instanceId && other.identity.projectId === registered.identity.projectId) {
                other.close(CloseCode.SUPERSEDED, 'superseded by a newer connection');
              }
            }
          },
        },
      );
      this.sessions.add(session);
    });
  }

  /**
   * Stop accepting connections and close sessions with GOING_AWAY. SDKs reconnect
   * (to another replica) and keep their running executions' leases alive.
   */
  async onModuleDestroy(): Promise<void> {
    this.accepting = false;
    this.unsubscribeCancel?.();
    this.adapterHost.httpAdapter?.getHttpServer()?.off('upgrade', this.upgradeHandler);
    for (const session of this.sessions) session.close(CloseCode.GOING_AWAY, 'server shutting down');
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    this.logger.log('Agent gateway closed');
  }
}
