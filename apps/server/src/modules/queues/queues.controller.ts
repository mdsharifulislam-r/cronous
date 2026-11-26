import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { QueueSubmission, queueBatchSchema, queueSubmissionSchema } from '@chronos/protocol';
import { ZodValidationPipe, uuidParam } from '../../common/http/zod-validation.pipe';
import type { AccessScope, ChronosRequest, Principal } from '../../common/http/request-context';
import { AllowPrincipals, CurrentPrincipal, CurrentScope, RequireRole } from '../auth/auth.decorators';
import { CreateQueueInput, UpdateQueueInput, createQueueSchema, queueNameParam, updateQueueSchema } from './queues.schemas';
import { QueuesService } from './queues.service';
import { SubmissionsService } from './submissions.service';

const nameParam = new ZodValidationPipe(queueNameParam);

/** Queue (admission lane) management. */
@Controller('projects/:projectId/queues')
export class QueuesController {
  constructor(private readonly queues: QueuesService) {}

  @Get()
  @AllowPrincipals('user', 'project')
  @RequireRole('VIEWER')
  list(@Param('projectId', uuidParam) projectId: string) {
    return this.queues.list(projectId);
  }

  @Get(':name')
  @AllowPrincipals('user', 'project')
  @RequireRole('VIEWER')
  get(@Param('projectId', uuidParam) projectId: string, @Param('name', nameParam) name: string) {
    return this.queues.get(projectId, name);
  }

  @Post()
  @RequireRole('ADMIN')
  create(
    @Param('projectId', uuidParam) projectId: string,
    @Body(new ZodValidationPipe(createQueueSchema)) body: CreateQueueInput,
    @CurrentScope() scope: AccessScope,
    @CurrentPrincipal() principal: Principal,
    @Req() request: ChronosRequest,
  ) {
    return this.queues.create(projectId, scope.organizationId, body, principal, { requestId: request.id });
  }

  @Patch(':name')
  @RequireRole('ADMIN')
  update(
    @Param('projectId', uuidParam) projectId: string,
    @Param('name', nameParam) name: string,
    @Body(new ZodValidationPipe(updateQueueSchema)) body: UpdateQueueInput,
    @CurrentScope() scope: AccessScope,
    @CurrentPrincipal() principal: Principal,
    @Req() request: ChronosRequest,
  ) {
    return this.queues.update(projectId, scope.organizationId, name, body, principal, { requestId: request.id });
  }

  @Delete(':name')
  @RequireRole('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(
    @Param('projectId', uuidParam) projectId: string,
    @Param('name', nameParam) name: string,
    @CurrentScope() scope: AccessScope,
    @CurrentPrincipal() principal: Principal,
    @Req() request: ChronosRequest,
  ): Promise<void> {
    await this.queues.delete(projectId, scope.organizationId, name, principal, { requestId: request.id });
  }

  /** Paused queues accept submissions but admit nothing; running executions continue. */
  @Post(':name/pause')
  @AllowPrincipals('user', 'project')
  @RequireRole('MEMBER')
  @HttpCode(HttpStatus.OK)
  pause(
    @Param('projectId', uuidParam) projectId: string,
    @Param('name', nameParam) name: string,
    @CurrentScope() scope: AccessScope,
    @CurrentPrincipal() principal: Principal,
    @Req() request: ChronosRequest,
  ) {
    return this.queues.setPaused(projectId, scope.organizationId, name, true, principal, { requestId: request.id });
  }

  @Post(':name/resume')
  @AllowPrincipals('user', 'project')
  @RequireRole('MEMBER')
  @HttpCode(HttpStatus.OK)
  resume(
    @Param('projectId', uuidParam) projectId: string,
    @Param('name', nameParam) name: string,
    @CurrentScope() scope: AccessScope,
    @CurrentPrincipal() principal: Principal,
    @Req() request: ChronosRequest,
  ) {
    return this.queues.setPaused(projectId, scope.organizationId, name, false, principal, { requestId: request.id });
  }
}

/**
 * Job submission for immediate or delayed execution. Agent tokens (the SDK's
 * `chronos.queue()`) are accepted here, and only here among the REST routes, besides
 * cancelling not-yet-started executions.
 */
@Controller('projects/:projectId/queue')
@AllowPrincipals('user', 'project', 'agent')
export class SubmissionsController {
  constructor(private readonly submissions: SubmissionsService) {}

  /** 201 for a new execution, 200 when the idempotency key matched an existing one. */
  @Post()
  @RequireRole('MEMBER')
  async submit(
    @Param('projectId', uuidParam) projectId: string,
    @Body(new ZodValidationPipe(queueSubmissionSchema)) body: QueueSubmission,
    @CurrentScope() scope: AccessScope,
    @CurrentPrincipal() principal: Principal,
    @Req() request: ChronosRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.submissions.submit(projectId, scope.organizationId, body, principal, { requestId: request.id });
    response.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return result;
  }

  /** Up to 100 submissions; per-item results. Always 200 when the request itself is valid. */
  @Post('batch')
  @RequireRole('MEMBER')
  @HttpCode(HttpStatus.OK)
  batch(
    @Param('projectId', uuidParam) projectId: string,
    @Body(new ZodValidationPipe(queueBatchSchema)) body: { items: QueueSubmission[] },
    @CurrentScope() scope: AccessScope,
    @CurrentPrincipal() principal: Principal,
    @Req() request: ChronosRequest,
  ) {
    return this.submissions.submitBatch(projectId, scope.organizationId, body.items, principal, { requestId: request.id });
  }
}
