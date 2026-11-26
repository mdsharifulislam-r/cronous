import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ZodValidationPipe, uuidParam } from '../../common/http/zod-validation.pipe';
import type { AccessScope, ChronosRequest, Principal } from '../../common/http/request-context';
import { AllowPrincipals, CurrentPrincipal, CurrentScope, RequireRole } from '../auth/auth.decorators';
import {
  CreateJobInput,
  TriggerJobInput,
  UpdateJobInput,
  createJobSchema,
  ListJobsQuery,
  listJobsQuerySchema,
  previewQuerySchema,
  triggerJobSchema,
  updateJobSchema,
} from './jobs.schemas';
import { JobsService } from './jobs.service';

/** Project API keys may manage jobs of their own project (MEMBER-level). */
@Controller('projects/:projectId/jobs')
@AllowPrincipals('user', 'project')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Post()
  @RequireRole('MEMBER')
  create(
    @Param('projectId', uuidParam) projectId: string,
    @Body(new ZodValidationPipe(createJobSchema)) body: CreateJobInput,
    @CurrentScope() scope: AccessScope,
    @CurrentPrincipal() principal: Principal,
    @Req() request: ChronosRequest,
  ) {
    return this.jobs.create(projectId, scope.organizationId, body, principal, { requestId: request.id });
  }

  @Get()
  @RequireRole('VIEWER')
  list(
    @Param('projectId', uuidParam) projectId: string,
    @Query(new ZodValidationPipe(listJobsQuerySchema)) query: ListJobsQuery,
  ) {
    return this.jobs.list(projectId, query);
  }

  @Get(':jobId')
  @RequireRole('VIEWER')
  get(@Param('projectId', uuidParam) projectId: string, @Param('jobId', uuidParam) jobId: string) {
    return this.jobs.get(projectId, jobId);
  }

  @Get(':jobId/schedule/preview')
  @RequireRole('VIEWER')
  preview(
    @Param('projectId', uuidParam) projectId: string,
    @Param('jobId', uuidParam) jobId: string,
    @Query(new ZodValidationPipe(previewQuerySchema)) query: { count: number },
  ) {
    return this.jobs.preview(projectId, jobId, query.count);
  }

  @Patch(':jobId')
  @RequireRole('MEMBER')
  update(
    @Param('projectId', uuidParam) projectId: string,
    @Param('jobId', uuidParam) jobId: string,
    @Body(new ZodValidationPipe(updateJobSchema)) body: UpdateJobInput,
    @CurrentScope() scope: AccessScope,
    @CurrentPrincipal() principal: Principal,
    @Req() request: ChronosRequest,
  ) {
    return this.jobs.update(projectId, scope.organizationId, jobId, body, principal, { requestId: request.id });
  }

  @Delete(':jobId')
  @RequireRole('MEMBER')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(
    @Param('projectId', uuidParam) projectId: string,
    @Param('jobId', uuidParam) jobId: string,
    @CurrentScope() scope: AccessScope,
    @CurrentPrincipal() principal: Principal,
    @Req() request: ChronosRequest,
  ): Promise<void> {
    await this.jobs.delete(projectId, scope.organizationId, jobId, principal, { requestId: request.id });
  }

  @Post(':jobId/pause')
  @RequireRole('MEMBER')
  @HttpCode(HttpStatus.OK)
  pause(
    @Param('projectId', uuidParam) projectId: string,
    @Param('jobId', uuidParam) jobId: string,
    @CurrentScope() scope: AccessScope,
    @CurrentPrincipal() principal: Principal,
    @Req() request: ChronosRequest,
  ) {
    return this.jobs.setPaused(projectId, scope.organizationId, jobId, true, principal, { requestId: request.id });
  }

  @Post(':jobId/resume')
  @RequireRole('MEMBER')
  @HttpCode(HttpStatus.OK)
  resume(
    @Param('projectId', uuidParam) projectId: string,
    @Param('jobId', uuidParam) jobId: string,
    @CurrentScope() scope: AccessScope,
    @CurrentPrincipal() principal: Principal,
    @Req() request: ChronosRequest,
  ) {
    return this.jobs.setPaused(projectId, scope.organizationId, jobId, false, principal, { requestId: request.id });
  }

  /** 201 for a new execution, 200 when an idempotency key matched an existing one. */
  @Post(':jobId/trigger')
  @RequireRole('MEMBER')
  async trigger(
    @Param('projectId', uuidParam) projectId: string,
    @Param('jobId', uuidParam) jobId: string,
    @Body(new ZodValidationPipe(triggerJobSchema)) body: TriggerJobInput,
    @CurrentScope() scope: AccessScope,
    @CurrentPrincipal() principal: Principal,
    @Req() request: ChronosRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.jobs.trigger(projectId, scope.organizationId, jobId, body, principal, { requestId: request.id });
    response.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return result;
  }
}
