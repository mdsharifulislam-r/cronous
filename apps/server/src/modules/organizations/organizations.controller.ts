import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Req } from '@nestjs/common';
import { ZodValidationPipe, uuidParam } from '../../common/http/zod-validation.pipe';
import type { AccessScope, ChronosRequest, Principal } from '../../common/http/request-context';
import { CurrentPrincipal, CurrentScope, CurrentUserId, RequireRole } from '../auth/auth.decorators';
import { MembersService } from './members.service';
import {
  AddMemberInput,
  CreateOrganizationInput,
  UpdateMemberInput,
  UpdateOrganizationInput,
  addMemberSchema,
  createOrganizationSchema,
  updateMemberSchema,
  updateOrganizationSchema,
} from './organizations.schemas';
import { OrganizationsService } from './organizations.service';

@Controller('organizations')
export class OrganizationsController {
  constructor(
    private readonly organizations: OrganizationsService,
    private readonly members: MembersService,
  ) {}

  @Post()
  create(
    @Body(new ZodValidationPipe(createOrganizationSchema)) body: CreateOrganizationInput,
    @CurrentPrincipal() principal: Principal,
    @Req() request: ChronosRequest,
  ) {
    return this.organizations.create(body, principal as Principal & { type: 'user' }, { requestId: request.id });
  }

  @Get()
  list(@CurrentUserId() userId: string) {
    return this.organizations.listForUser(userId);
  }

  @Get(':orgId')
  @RequireRole('VIEWER')
  get(@Param('orgId', uuidParam) orgId: string) {
    return this.organizations.get(orgId);
  }

  @Patch(':orgId')
  @RequireRole('ADMIN')
  update(
    @Param('orgId', uuidParam) orgId: string,
    @Body(new ZodValidationPipe(updateOrganizationSchema)) body: UpdateOrganizationInput,
    @CurrentPrincipal() principal: Principal,
    @Req() request: ChronosRequest,
  ) {
    return this.organizations.update(orgId, body, principal, { requestId: request.id });
  }

  @Delete(':orgId')
  @RequireRole('OWNER')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(
    @Param('orgId', uuidParam) orgId: string,
    @CurrentPrincipal() principal: Principal,
    @Req() request: ChronosRequest,
  ): Promise<void> {
    await this.organizations.delete(orgId, principal, { requestId: request.id });
  }

  // -------------------------------------------------------------------------
  // Members
  // -------------------------------------------------------------------------

  @Get(':orgId/members')
  @RequireRole('VIEWER')
  listMembers(@Param('orgId', uuidParam) orgId: string) {
    return this.members.list(orgId);
  }

  @Post(':orgId/members')
  @RequireRole('ADMIN')
  addMember(
    @Body(new ZodValidationPipe(addMemberSchema)) body: AddMemberInput,
    @CurrentScope() scope: AccessScope,
    @CurrentPrincipal() principal: Principal,
    @Req() request: ChronosRequest,
  ) {
    return this.members.add(scope, body, principal, { requestId: request.id });
  }

  @Patch(':orgId/members/:userId')
  @RequireRole('ADMIN')
  updateMember(
    @Param('userId', uuidParam) userId: string,
    @Body(new ZodValidationPipe(updateMemberSchema)) body: UpdateMemberInput,
    @CurrentScope() scope: AccessScope,
    @CurrentPrincipal() principal: Principal,
    @Req() request: ChronosRequest,
  ) {
    return this.members.updateRole(scope, userId, body, principal, { requestId: request.id });
  }

  /** Viewers may remove themselves (leave); removing others requires ADMIN (checked in the service). */
  @Delete(':orgId/members/:userId')
  @RequireRole('VIEWER')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeMember(
    @Param('userId', uuidParam) userId: string,
    @CurrentScope() scope: AccessScope,
    @CurrentPrincipal() principal: Principal,
    @Req() request: ChronosRequest,
  ): Promise<void> {
    await this.members.remove(scope, userId, principal, { requestId: request.id });
  }
}
