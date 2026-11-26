import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ZodValidationPipe, uuidParam } from '../../common/http/zod-validation.pipe';
import type { AccessScope, ChronosRequest, Principal } from '../../common/http/request-context';
import { AllowPrincipals, CurrentPrincipal, CurrentScope, RequireRole } from '../auth/auth.decorators';
import {
  CreateCredentialInput,
  CreateProjectInput,
  RotateCredentialInput,
  UpdateProjectInput,
  createCredentialSchema,
  createProjectSchema,
  listCredentialsQuerySchema,
  rotateCredentialSchema,
  updateProjectSchema,
} from './projects.schemas';
import { ProjectsService } from './projects.service';

@Controller()
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Post('organizations/:orgId/projects')
  @RequireRole('ADMIN')
  create(
    @Param('orgId', uuidParam) orgId: string,
    @Body(new ZodValidationPipe(createProjectSchema)) body: CreateProjectInput,
    @CurrentPrincipal() principal: Principal,
    @Req() request: ChronosRequest,
  ) {
    return this.projects.create(orgId, body, principal, { requestId: request.id });
  }

  @Get('organizations/:orgId/projects')
  @RequireRole('VIEWER')
  list(@Param('orgId', uuidParam) orgId: string) {
    return this.projects.list(orgId);
  }

  /** Project keys may read their own project (the SDK uses this to verify configuration). */
  @Get('projects/:projectId')
  @AllowPrincipals('user', 'project')
  @RequireRole('VIEWER')
  get(@Param('projectId', uuidParam) projectId: string) {
    return this.projects.get(projectId);
  }

  @Patch('projects/:projectId')
  @RequireRole('ADMIN')
  update(
    @Param('projectId', uuidParam) projectId: string,
    @Body(new ZodValidationPipe(updateProjectSchema)) body: UpdateProjectInput,
    @CurrentPrincipal() principal: Principal,
    @Req() request: ChronosRequest,
  ) {
    return this.projects.update(projectId, body, principal, { requestId: request.id });
  }

  @Delete('projects/:projectId')
  @RequireRole('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  async archive(
    @Param('projectId', uuidParam) projectId: string,
    @CurrentPrincipal() principal: Principal,
    @Req() request: ChronosRequest,
  ): Promise<void> {
    await this.projects.archive(projectId, principal, { requestId: request.id });
  }

  // -------------------------------------------------------------------------
  // Credentials
  // -------------------------------------------------------------------------

  @Get('projects/:projectId/credentials')
  @RequireRole('ADMIN')
  listCredentials(
    @Param('projectId', uuidParam) projectId: string,
    @Query(new ZodValidationPipe(listCredentialsQuerySchema)) query: { includeRevoked: boolean },
  ) {
    return this.projects.listCredentials(projectId, query.includeRevoked);
  }

  @Post('projects/:projectId/credentials')
  @RequireRole('ADMIN')
  createCredential(
    @Param('projectId', uuidParam) projectId: string,
    @Body(new ZodValidationPipe(createCredentialSchema)) body: CreateCredentialInput,
    @CurrentScope() scope: AccessScope,
    @CurrentPrincipal() principal: Principal,
    @Req() request: ChronosRequest,
  ) {
    return this.projects.createCredential(scope.organizationId, projectId, body, principal, { requestId: request.id });
  }

  @Post('projects/:projectId/credentials/:credentialId/rotate')
  @RequireRole('ADMIN')
  rotateCredential(
    @Param('projectId', uuidParam) projectId: string,
    @Param('credentialId', uuidParam) credentialId: string,
    @Body(new ZodValidationPipe(rotateCredentialSchema)) body: RotateCredentialInput,
    @CurrentScope() scope: AccessScope,
    @CurrentPrincipal() principal: Principal,
    @Req() request: ChronosRequest,
  ) {
    return this.projects.rotateCredential(scope.organizationId, projectId, credentialId, body, principal, {
      requestId: request.id,
    });
  }

  @Delete('projects/:projectId/credentials/:credentialId')
  @RequireRole('ADMIN')
  revokeCredential(
    @Param('projectId', uuidParam) projectId: string,
    @Param('credentialId', uuidParam) credentialId: string,
    @CurrentScope() scope: AccessScope,
    @CurrentPrincipal() principal: Principal,
    @Req() request: ChronosRequest,
  ) {
    return this.projects.revokeCredential(scope.organizationId, projectId, credentialId, principal, { requestId: request.id });
  }
}
