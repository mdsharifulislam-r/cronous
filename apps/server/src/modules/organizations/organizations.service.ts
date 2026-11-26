import { Injectable } from '@nestjs/common';
import { isUniqueViolation } from '@chronos/database';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AppException } from '../../common/http/app-exception';
import type { Principal } from '../../common/http/request-context';
import { AuditService } from '../audit/audit.service';
import type { RequestMeta } from '../auth/auth.service';
import type { CreateOrganizationInput, UpdateOrganizationInput } from './organizations.schemas';

const organizationView = { id: true, name: true, slug: true, createdAt: true, updatedAt: true } as const;

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(input: CreateOrganizationInput, principal: Principal & { type: 'user' }, meta: RequestMeta) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const organization = await tx.organization.create({ data: input, select: organizationView });
        await tx.membership.create({ data: { organizationId: organization.id, userId: principal.userId, role: 'OWNER' } });
        await this.audit.record(
          {
            action: 'organization.created',
            principal,
            organizationId: organization.id,
            targetType: 'organization',
            targetId: organization.id,
            requestId: meta.requestId,
          },
          tx,
        );
        return { ...organization, role: 'OWNER' as const };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw AppException.conflict(`Organization slug "${input.slug}" is already taken`);
      throw error;
    }
  }

  async listForUser(userId: string) {
    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      select: { role: true, organization: { select: organizationView } },
      orderBy: { organization: { name: 'asc' } },
    });
    return memberships.map((membership) => ({ ...membership.organization, role: membership.role }));
  }

  async get(organizationId: string) {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { ...organizationView, _count: { select: { projects: { where: { archivedAt: null } }, memberships: true } } },
    });
    if (!organization) throw AppException.notFound('Organization');
    const { _count, ...rest } = organization;
    return { ...rest, projectCount: _count.projects, memberCount: _count.memberships };
  }

  async update(organizationId: string, input: UpdateOrganizationInput, principal: Principal, meta: RequestMeta) {
    return this.prisma.$transaction(async (tx) => {
      const organization = await tx.organization.update({ where: { id: organizationId }, data: input, select: organizationView });
      await this.audit.record(
        {
          action: 'organization.updated',
          principal,
          organizationId,
          targetType: 'organization',
          targetId: organizationId,
          metadata: input,
          requestId: meta.requestId,
        },
        tx,
      );
      return organization;
    });
  }

  /**
   * Deletes the organization and, by cascade, its projects, jobs, execution history and
   * credentials. Audit entries are kept (organization_id is set to NULL).
   */
  async delete(organizationId: string, principal: Principal, meta: RequestMeta): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const organization = await tx.organization.findUnique({ where: { id: organizationId }, select: { slug: true } });
      if (!organization) throw AppException.notFound('Organization');
      await this.audit.record(
        {
          action: 'organization.deleted',
          principal,
          targetType: 'organization',
          targetId: organizationId,
          metadata: { slug: organization.slug },
          requestId: meta.requestId,
        },
        tx,
      );
      await tx.organization.delete({ where: { id: organizationId } });
    });
  }
}
