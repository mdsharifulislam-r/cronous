import { resolveQueueId } from '@chronos/engine';
import { DEFAULT_QUEUE } from '@chronos/protocol';
import { Injectable } from '@nestjs/common';
import { Prisma, isUniqueViolation } from '@chronos/database';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AppException } from '../../common/http/app-exception';
import type { Principal } from '../../common/http/request-context';
import { AuditService } from '../audit/audit.service';
import type { RequestMeta } from '../auth/auth.service';
import { CredentialsService } from '../auth/credentials.service';
import type { CreateCredentialInput, CreateProjectInput, RotateCredentialInput, UpdateProjectInput } from './projects.schemas';

const projectView = {
  id: true,
  organizationId: true,
  name: true,
  slug: true,
  timezone: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ProjectSelect;

function userIdOf(principal: Principal): string | null {
  return principal.type === 'user' ? principal.userId : null;
}

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialsService,
    private readonly audit: AuditService,
  ) {}

  async create(organizationId: string, input: CreateProjectInput, principal: Principal, meta: RequestMeta) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const project = await tx.project.create({ data: { ...input, organizationId }, select: projectView });
        await resolveQueueId(tx, project.id, DEFAULT_QUEUE);
        await this.audit.record(
          {
            action: 'project.created',
            principal,
            organizationId,
            projectId: project.id,
            targetType: 'project',
            targetId: project.id,
            requestId: meta.requestId,
          },
          tx,
        );
        return project;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw AppException.conflict(`Project slug "${input.slug}" already exists in this organization`);
      throw error;
    }
  }

  list(organizationId: string) {
    return this.prisma.project.findMany({
      where: { organizationId, archivedAt: null },
      select: projectView,
      orderBy: { name: 'asc' },
    });
  }

  async get(projectId: string) {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, archivedAt: null }, select: projectView });
    if (!project) throw AppException.notFound('Project');
    return project;
  }

  async update(projectId: string, input: UpdateProjectInput, principal: Principal, meta: RequestMeta) {
    return this.prisma.$transaction(async (tx) => {
      const project = await tx.project.update({ where: { id: projectId }, data: input, select: projectView });
      await this.audit.record(
        {
          action: 'project.updated',
          principal,
          organizationId: project.organizationId,
          projectId,
          targetType: 'project',
          targetId: projectId,
          metadata: input,
          requestId: meta.requestId,
        },
        tx,
      );
      return project;
    });
  }

  /**
   * Archives rather than deletes, preserving execution history. All project and agent
   * credentials are revoked so archived projects can no longer be driven.
   */
  async archive(projectId: string, principal: Principal, meta: RequestMeta): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const project = await tx.project.update({
        where: { id: projectId },
        data: { archivedAt: new Date() },
        select: { organizationId: true },
      });
      const revoked = await this.credentials.revokeAllForProject(projectId, tx);
      await this.audit.record(
        {
          action: 'project.archived',
          principal,
          organizationId: project.organizationId,
          projectId,
          targetType: 'project',
          targetId: projectId,
          metadata: { revokedCredentials: revoked },
          requestId: meta.requestId,
        },
        tx,
      );
    });
  }

  // -------------------------------------------------------------------------
  // Credentials
  // -------------------------------------------------------------------------

  listCredentials(projectId: string, includeRevoked: boolean) {
    return this.credentials.listProjectCredentials(projectId, includeRevoked);
  }

  async createCredential(
    organizationId: string,
    projectId: string,
    input: CreateCredentialInput,
    principal: Principal,
    meta: RequestMeta,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const issued = await this.credentials.createProjectCredential(
        {
          projectId,
          kind: input.kind,
          name: input.name,
          expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null,
          createdByUserId: userIdOf(principal),
        },
        tx,
      );
      await this.audit.record(
        {
          action: 'credential.created',
          principal,
          organizationId,
          projectId,
          targetType: 'credential',
          targetId: issued.credential.id,
          metadata: { kind: input.kind, name: input.name },
          requestId: meta.requestId,
        },
        tx,
      );
      return { ...issued.credential, token: issued.token };
    });
  }

  async rotateCredential(
    organizationId: string,
    projectId: string,
    credentialId: string,
    input: RotateCredentialInput,
    principal: Principal,
    meta: RequestMeta,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const rotated = await this.credentials.rotate(projectId, credentialId, input.gracePeriodSeconds, userIdOf(principal), tx);
      await this.audit.record(
        {
          action: 'credential.rotated',
          principal,
          organizationId,
          projectId,
          targetType: 'credential',
          targetId: credentialId,
          metadata: { replacementId: rotated.credential.id, gracePeriodSeconds: input.gracePeriodSeconds },
          requestId: meta.requestId,
        },
        tx,
      );
      return { credential: { ...rotated.credential, token: rotated.token }, previous: rotated.previous };
    });
  }

  async revokeCredential(organizationId: string, projectId: string, credentialId: string, principal: Principal, meta: RequestMeta) {
    return this.prisma.$transaction(async (tx) => {
      const credential = await this.credentials.revoke({ id: credentialId, projectId }, tx);
      await this.audit.record(
        {
          action: 'credential.revoked',
          principal,
          organizationId,
          projectId,
          targetType: 'credential',
          targetId: credentialId,
          requestId: meta.requestId,
        },
        tx,
      );
      return credential;
    });
  }
}
