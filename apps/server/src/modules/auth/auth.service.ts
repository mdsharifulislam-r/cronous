import { Inject, Injectable } from '@nestjs/common';
import { getDummyPasswordHash, hashPassword, verifyPassword } from '@chronos/shared';
import { APP_CONFIG } from '../../config/config.module';
import { ServerEnv } from '../../config/env.schema';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AppException } from '../../common/http/app-exception';
import type { Principal } from '../../common/http/request-context';
import { AuditService } from '../audit/audit.service';
import type { ChangePasswordInput, LoginInput, UpdateProfileInput } from './auth.schemas';
import { CredentialsService } from './credentials.service';
import { LoginThrottleService } from './login-throttle.service';

export interface RequestMeta {
  requestId: string;
  ipAddress?: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialsService,
    private readonly throttle: LoginThrottleService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: ServerEnv,
  ) {}

  async login(input: LoginInput, meta: RequestMeta) {
    const lockedFor = await this.throttle.lockedForSeconds(input.email);
    if (lockedFor > 0) throw AppException.tooManyRequests('Too many failed login attempts', lockedFor);

    const user = await this.prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true, email: true, name: true, passwordHash: true, isActive: true },
    });
    // Always run a full hash verification so response time does not reveal whether
    // the account exists.
    const valid = await verifyPassword(input.password, user?.passwordHash ?? (await getDummyPasswordHash()));
    if (!user || !valid || !user.isActive) {
      await this.throttle.recordFailure(input.email);
      await this.audit.record({
        action: 'auth.login_failed',
        targetType: 'user',
        ...(user ? { targetId: user.id } : {}),
        requestId: meta.requestId,
        ...(meta.ipAddress ? { ipAddress: meta.ipAddress } : {}),
      });
      throw AppException.unauthorized('Invalid email or password');
    }

    await this.throttle.reset(input.email);
    const issued = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      return this.credentials.issueUserToken(user.id, this.config.CHRONOS_USER_TOKEN_TTL_HOURS, tx);
    });
    await this.audit.record({
      action: 'auth.login',
      principal: { type: 'user', userId: user.id, credentialId: issued.credential.id },
      targetType: 'user',
      targetId: user.id,
      requestId: meta.requestId,
      ...(meta.ipAddress ? { ipAddress: meta.ipAddress } : {}),
    });

    return {
      token: issued.token,
      expiresAt: issued.credential.expiresAt,
      user: { id: user.id, email: user.email, name: user.name },
    };
  }

  async logout(principal: Principal, meta: RequestMeta): Promise<void> {
    if (principal.type !== 'user') throw AppException.forbidden();
    await this.credentials.revoke({ id: principal.credentialId, userId: principal.userId });
    await this.audit.record({
      action: 'auth.logout',
      principal,
      targetType: 'credential',
      targetId: principal.credentialId,
      requestId: meta.requestId,
    });
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
        lastLoginAt: true,
        memberships: {
          select: { role: true, organization: { select: { id: true, name: true, slug: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!user) throw AppException.unauthorized();
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
      organizations: user.memberships.map((membership) => ({ ...membership.organization, role: membership.role })),
    };
  }

  async updateProfile(principal: Principal & { type: 'user' }, input: UpdateProfileInput, meta: RequestMeta) {
    await this.prisma.user.update({ where: { id: principal.userId }, data: { name: input.name } });
    await this.audit.record({ action: 'user.profile_updated', principal, targetType: 'user', targetId: principal.userId, requestId: meta.requestId });
    return this.me(principal.userId);
  }

  /**
   * Changes the caller's password after verifying the current one. Every other session
   * of the user is revoked; the session making the request stays valid. Wrong current
   * passwords count towards the same lockout as failed logins, so a stolen session token
   * cannot be used to brute-force the password.
   */
  async changePassword(principal: Principal & { type: 'user' }, input: ChangePasswordInput, meta: RequestMeta) {
    const user = await this.prisma.user.findUnique({ where: { id: principal.userId }, select: { email: true, passwordHash: true } });
    if (!user) throw AppException.unauthorized();
    const lockedFor = await this.throttle.lockedForSeconds(user.email);
    if (lockedFor > 0) throw AppException.tooManyRequests('Too many failed password attempts', lockedFor);
    if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
      await this.throttle.recordFailure(user.email);
      throw AppException.badRequest('Current password is incorrect');
    }
    const passwordHash = await hashPassword(input.newPassword);
    const revoked = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: principal.userId }, data: { passwordHash } });
      const result = await tx.apiCredential.updateMany({
        where: { userId: principal.userId, kind: 'USER', revokedAt: null, id: { not: principal.credentialId } },
        data: { revokedAt: new Date() },
      });
      await this.audit.record(
        { action: 'user.password_changed', principal, targetType: 'user', targetId: principal.userId, metadata: { revokedSessions: result.count }, requestId: meta.requestId },
        tx,
      );
      return result.count;
    });
    await this.throttle.reset(user.email);
    return { revokedSessions: revoked };
  }
}
