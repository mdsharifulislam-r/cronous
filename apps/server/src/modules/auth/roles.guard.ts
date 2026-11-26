import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { OrgRole } from '@chronos/database';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AppException } from '../../common/http/app-exception';
import type { AccessScope, ChronosRequest } from '../../common/http/request-context';
import { REQUIRED_ROLE } from './auth.decorators';
import { MACHINE_PRINCIPAL_MAX_ROLE, roleSatisfies } from './roles';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Role-based access control. Resolves the organization from `:projectId` or `:orgId`,
 * checks the caller's membership role, and attaches the resolved scope to the request.
 *
 * Non-members receive 404 rather than 403 so that resource ids cannot be probed.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const required = this.reflector.getAllAndOverride<OrgRole>(REQUIRED_ROLE, [context.getHandler(), context.getClass()]);
    if (!required) return true;

    const request = context.switchToHttp().getRequest<ChronosRequest>();
    const principal = request.principal;
    if (!principal) throw AppException.unauthorized();

    const { projectId: projectParam, orgId: orgParam } = request.params as { projectId?: string; orgId?: string };
    let scope: AccessScope;
    let resource: string;

    if (projectParam !== undefined) {
      resource = 'Project';
      if (!UUID.test(projectParam)) throw AppException.notFound(resource);
      const project = await this.prisma.project.findUnique({
        where: { id: projectParam },
        select: { id: true, organizationId: true, archivedAt: true },
      });
      if (!project || project.archivedAt) throw AppException.notFound(resource);
      scope = { organizationId: project.organizationId, projectId: project.id };
    } else if (orgParam !== undefined) {
      resource = 'Organization';
      if (!UUID.test(orgParam)) throw AppException.notFound(resource);
      scope = { organizationId: orgParam };
    } else {
      // Programming error: fail closed rather than silently allowing access.
      throw new Error(`@RequireRole on ${context.getClass().name}.${context.getHandler().name} needs :orgId or :projectId`);
    }

    if (principal.type === 'user') {
      const membership = await this.prisma.membership.findUnique({
        where: { organizationId_userId: { organizationId: scope.organizationId, userId: principal.userId } },
        select: { role: true },
      });
      if (!membership) throw AppException.notFound(resource);
      if (!roleSatisfies(membership.role, required)) throw AppException.forbidden();
      scope.role = membership.role;
    } else {
      // Machine credentials are confined to their own project.
      if (!scope.projectId || scope.projectId !== principal.projectId) throw AppException.notFound(resource);
      if (!roleSatisfies(MACHINE_PRINCIPAL_MAX_ROLE, required)) throw AppException.forbidden();
    }

    request.scope = scope;
    return true;
  }
}
