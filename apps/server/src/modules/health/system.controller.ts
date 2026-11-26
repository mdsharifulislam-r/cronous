import { Controller, Get, Inject } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import { ServerEnv } from '../../config/env.schema';
import { API_VERSION } from '../../common/http/api-response';
import { PROTOCOL_VERSION } from '@chronos/protocol';

export const SERVER_VERSION = '0.1.0';

/**
 * Non-sensitive installation facts for any signed-in user: versions, server clock (to
 * correct client clock skew in countdowns), and which optional features are enabled.
 */
@Controller('system')
export class SystemController {
  constructor(@Inject(APP_CONFIG) private readonly config: ServerEnv) {}

  @Get()
  info() {
    return {
      version: SERVER_VERSION,
      apiVersion: API_VERSION,
      agentProtocolVersion: PROTOCOL_VERSION,
      serverTime: new Date(),
      features: {
        embeddedScheduler: this.config.CHRONOS_EMBEDDED_SCHEDULER,
        embeddedWorker: this.config.CHRONOS_EMBEDDED_WORKER,
        bundledDashboard: this.config.CHRONOS_DASHBOARD_ENABLED,
        eventStream: true,
      },
      limits: {
        userTokenTtlHours: this.config.CHRONOS_USER_TOKEN_TTL_HOURS,
        executionRetentionDays: this.config.CHRONOS_EXECUTION_RETENTION_DAYS,
        agentHeartbeatMs: this.config.CHRONOS_AGENT_HEARTBEAT_MS,
        leaseMs: this.config.CHRONOS_LEASE_MS,
        eventsPollMs: this.config.CHRONOS_EVENTS_POLL_MS,
      },
    };
  }
}
