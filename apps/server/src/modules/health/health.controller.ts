import { Controller, Get, HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { Public } from '../auth/auth.decorators';
import { HealthService } from './health.service';

/** Mounted outside the /v1 prefix so orchestrators get stable probe paths. */
@Controller('health')
@Public()
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(private readonly health: HealthService) {}

  /** Liveness: the process is running and the event loop responds. No dependency checks. */
  @Get('live')
  live() {
    return { status: 'alive', uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000) };
  }

  /** Readiness: PostgreSQL and Redis are reachable. Returns 503 otherwise. */
  @Get('ready')
  async ready() {
    const report = await this.health.readiness();
    if (report.status !== 'ready') {
      throw new AppException(HttpStatus.SERVICE_UNAVAILABLE, 'SERVICE_UNAVAILABLE', 'Dependencies unavailable', report);
    }
    return report;
  }
}
