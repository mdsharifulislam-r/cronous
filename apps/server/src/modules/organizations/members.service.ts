import { Injectable } from '@nestjs/common';
import { OrgRole, Prisma, isUniqueViolation } from '@chronos/database';
import { hashPassword } from '@chronos/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AppException } from '../../common/http/app-exception';
import type { AccessScope, Principal } from '../../common/http/request-context';
import { AuditService } from '../audit/audit.service';
import type { RequestMeta } from '../auth/auth.service';
import { canManageRole } from '../auth/roles';
import type { AddMemberInput, UpdateMemberInput } from './organizations.schemas';

const memberView = {
  role: true,
  createdAt: true,
  user: { select: { id: true, email: true, name: true, isActive: true } },
} satisfies Prisma.MembershipSelect;

type MemberRow = Prisma.MembershipGetPayload<{ select: typeof memberView }>;

function toMember(row: MemberRow) {
  return { ...row.user, role: row.role, joinedAt: row.createdAt };
}

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(organizationId: string) {
    const rows = await this.prisma.membership.findMany({
      where: { organizationId },
      select: memberView,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toMember);
  }

  async add(scope: AccessScope, input: AddMemberInput, principal: Principal, meta: RequestMeta) {
    this.assertCanManage(scope, input.role);
    const passwordHash = input.password ? await hashPassword(input.password) : null;

    try {
      return await this.prisma.$transaction(async (tx) => {
        let user = await tx.user.findUnique({ where: { email: input.email }, select: { id: true } });
        let created = false;
        if (!user) {
          if (!passwordHash || !input.name) {
            throw AppException.notFound('User (provide name and password to create a new user)');
          }
          user = await tx.user.create({ data: { email: input.email, name: input.name, passwordHash }, select: { id: true } });
          created = true;
        } else if (passwordHash) {
          // Never let an org admin reset the password of an existing account.
          throw AppException.conflict('User already exists; omit name and password to add the existing account');
        }

        const membership = await tx.membership.create({
          data: { organizationId: scope.organizationId, userId: user.id, role: input.role },
          select: memberView,
        });
        await this.audit.record(
          {
            action: 'membership.added',
            principal,
            organizationId: scope.organizationId,
            targetType: 'user',
            targetId: user.id,
            metadata: { role: input.role, userCreated: created },
            requestId: meta.requestId,
          },
          tx,
        );
        return toMember(membership);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw AppException.conflict('User is already a member of this organization');
      throw error;
    }
  }

  async updateRole(scope: AccessScope, userId: string, input: UpdateMemberInput, principal: Principal, meta: RequestMeta) {
    return this.prisma.$transaction(async (tx) => {
      const { current, ownerCount } = await this.lockForChange(tx, scope.organizationId, userId);
      this.assertCanManage(scope, current.role);
      this.assertCanManage(scope, input.role);
      if (current.role === 'OWNER' && input.role !== 'OWNER') this.assertNotLastOwner(ownerCount);

      const updated = await tx.membership.update({ where: { id: current.id }, data: { role: input.role }, select: memberView });
      await this.audit.record(
        {
          action: 'membership.role_changed',
          principal,
          organizationId: scope.organizationId,
          targetType: 'user',
          targetId: userId,
          metadata: { from: current.role, to: input.role },
          requestId: meta.requestId,
        },
        tx,
      );
      return toMember(updated);
    });
  }

  async remove(scope: AccessScope, userId: string, principal: Principal, meta: RequestMeta): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const { current, ownerCount } = await this.lockForChange(tx, scope.organizationId, userId);
      const isSelf = principal.type === 'user' && principal.userId === userId;
      // Anyone may leave; removing others requires authority over their role.
      if (!isSelf) this.assertCanManage(scope, current.role);
      if (current.role === 'OWNER') this.assertNotLastOwner(ownerCount);

      await tx.membership.delete({ where: { id: current.id } });
      await this.audit.record(
        {
          action: 'membership.removed',
          principal,
          organizationId: scope.organizationId,
          targetType: 'user',
          targetId: userId,
          metadata: { role: current.role },
          requestId: meta.requestId,
        },
        tx,
      );
    });
  }

  private assertCanManage(scope: AccessScope, targetRole: OrgRole): void {
    if (!scope.role || !canManageRole(scope.role, targetRole)) {
      throw AppException.forbidden(`Your role cannot manage members with role ${targetRole}`);
    }
  }

  /**
   * Locks the target membership and every owner membership in one statement, in id
   * order. A single ordered lock acquisition avoids deadlocks between concurrent
   * changes, and holding the owner rows means two concurrent demotions cannot both see
   * "another owner exists" and leave the organization without an owner.
   */
  private async lockForChange(tx: Prisma.TransactionClient, organizationId: string, userId: string) {
    const rows = await tx.$queryRaw<{ id: string; role: OrgRole; user_id: string }[]>`
      SELECT id, role, user_id FROM memberships
      WHERE organization_id = ${organizationId}::uuid AND (role = 'OWNER' OR user_id = ${userId}::uuid)
      ORDER BY id
      FOR UPDATE`;
    const current = rows.find((row) => row.user_id === userId);
    if (!current) throw AppException.notFound('Member');
    return { current, ownerCount: rows.filter((row) => row.role === 'OWNER').length };
  }

  private assertNotLastOwner(ownerCount: number): void {
    if (ownerCount <= 1) throw AppException.conflict('An organization must keep at least one owner');
  }
}
