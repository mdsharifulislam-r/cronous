import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from '@nestjs/common';
import { ZodValidationPipe, uuidParam } from '../../common/http/zod-validation.pipe';
import type { AccessScope, ChronosRequest, Principal } from '../../common/http/request-context';
import { AllowPrincipals, CurrentPrincipal, CurrentScope, RequireRole } from '../auth/auth.decorators';
import {
  ListExecutionsQuery,
  ListLogsQuery,
  StatsQuery,
  TimeseriesQuery,
  listExecutionsQuerySchema,
  listLogsQuerySchema,
  statsQuerySchema,
  timeseriesQuerySchema,
} from './executions.schemas';
import { ExecutionsService } from './executions.service';

@Controller('projects/:projectId')
@AllowPrincipals('user', 'project')
export class ExecutionsController {
  constructor(private readonly executions: ExecutionsService) {}

  @Get('executions')
  @RequireRole('VIEWER')
  list(
    @Param('projectId', uuidParam) projectId: string,
    @Query(new ZodValidationPipe(listExecutionsQuerySchema)) query: ListExecutionsQuery,
  ) {
    return this.executions.list(projectId, query);
  }

  @Get('executions/:executionId')
  @RequireRole('VIEWER')
  get(@Param('projectId', uuidParam) projectId: string, @Param('executionId', uuidParam) executionId: string) {
    return this.executions.get(projectId, executionId);
  }

  @Get('executions/:executionId/logs')
  @RequireRole('VIEWER')
  logs(
    @Param('projectId', uuidParam) projectId: string,
    @Param('executionId', uuidParam) executionId: string,
    @Query(new ZodValidationPipe(listLogsQuerySchema)) query: ListLogsQuery,
  ) {
    return this.executions.logs(projectId, executionId, query);
  }

  @Post('executions/:executionId/cancel')
  @AllowPrincipals('user', 'project', 'agent')
  @RequireRole('MEMBER')
  @HttpCode(HttpStatus.OK)
  cancel(
    @Param('projectId', uuidParam) projectId: string,
    @Param('executionId', uuidParam) executionId: string,
    @CurrentScope() scope: AccessScope,
    @CurrentPrincipal() principal: Principal,
    @Req() request: ChronosRequest,
  ) {
    return this.executions.cancel(projectId, scope.organizationId, executionId, principal, { requestId: request.id });
  }

  /** Re-runs a dead-lettered, failed or cancelled execution. */
  @Post('executions/:executionId/retry')
  @RequireRole('MEMBER')
  @HttpCode(HttpStatus.OK)
  retry(
    @Param('projectId', uuidParam) projectId: string,
    @Param('executionId', uuidParam) executionId: string,
    @CurrentScope() scope: AccessScope,
    @CurrentPrincipal() principal: Principal,
    @Req() request: ChronosRequest,
  ) {
    return this.executions.replay(projectId, scope.organizationId, executionId, principal, { requestId: request.id });
  }

  @Get('stats')
  @RequireRole('VIEWER')
  stats(@Param('projectId', uuidParam) projectId: string, @Query(new ZodValidationPipe(statsQuerySchema)) query: StatsQuery) {
    return this.executions.stats(projectId, query);
  }

  @Get('stats/timeseries')
  @RequireRole('VIEWER')
  timeseries(@Param('projectId', uuidParam) projectId: string, @Query(new ZodValidationPipe(timeseriesQuerySchema)) query: TimeseriesQuery) {
    return this.executions.timeseries(projectId, query);
  }
}
