import { Injectable, Logger } from '@nestjs/common';
import { CredentialKind, Prisma } from '@chronos/database';
import { TokenKind, generateToken, hashToken, tokenKindOf } from '@chronos/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AppException } from '../../common/http/app-exception';
import type { Principal } from '../../common/http/request-context';

const KIND_BY_TOKEN: Partial<Record<TokenKind, CredentialKind>> = {
  user: 'USER',
  project: 'PROJECT',
  agent: 'AGENT',
};
const TOKEN_BY_KIND: Record<CredentialKind, TokenKind> = { USER: 'user', PROJECT: 'project', AGENT: 'agent' };

/** Avoid a database write on every request: only refresh lastUsedAt this often. */
const LAST_USED_RESOLUTION_MS = 60_000;
export const MAX_ROTATION_GRACE_SECONDS = 7 * 24 * 3600;

type Db = Prisma.TransactionClient | PrismaService;

export const credentialView = {
  id: true,
  kind: true,
  name: true,
  displayPrefix: true,
  projectId: true,
  expiresAt: true,
  lastUsedAt: true,
  revokedAt: true,
  rotatedFromId: true,
  createdAt: true,
} satisfies Prisma.ApiCredentialSelect;

export type CredentialView = Prisma.ApiCredentialGetPayload<{ select: typeof credentialView }>;

/** A newly issued credential. `token` is the only time the plaintext is available. */
export interface IssuedCredential {
  credential: CredentialView;
  token: string;
}

@Injectable()
export class CredentialsService {
  private readonly logger = new Logger(CredentialsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Resolves a bearer token to a principal, or null if it is not currently valid. */
  async resolve(token: string, now = new Date()): Promise<Principal | null> {
    return (await this.resolveWithReason(token, now)).principal;
  }

  /**
   * Like resolve(), and says why a token was refused: `unknown` (no such credential,
   * malformed: what guessing looks like) or `inactive` (a real credential that is revoked,
   * expired, or whose user/project is disabled: what an expired session looks like).
   */
  async resolveWithReason(token: string, now = new Date()): Promise<{ principal: Principal | null; reason: 'unknown' | 'inactive' | null }> {
    const principal = await this.lookup(token, now);
    return principal === 'unknown' || principal === 'inactive' ? { principal: null, reason: principal } : { principal, reason: null };
  }

  private async lookup(token: string, now: Date): Promise<Principal | 'unknown' | 'inactive'> {
    const tokenKind = tokenKindOf(token);
    const expectedKind = tokenKind ? KIND_BY_TOKEN[tokenKind] : undefined;
    if (!expectedKind || token.length > 128) return 'unknown';

    const credential = await this.prisma.apiCredential.findUnique({
      where: { tokenHash: hashToken(token) },
      select: {
        id: true,
        kind: true,
        userId: true,
        projectId: true,
        expiresAt: true,
        revokedAt: true,
        lastUsedAt: true,
        user: { select: { isActive: true } },
        project: { select: { organizationId: true, archivedAt: true } },
      },
    });
    if (!credential || credential.kind !== expectedKind) return 'unknown';
    if (credential.revokedAt) return 'inactive';
    if (credential.expiresAt && credential.expiresAt <= now) return 'inactive';

    this.touch(credential.id, credential.lastUsedAt, now);

    switch (credential.kind) {
      case 'USER':
        if (!credential.userId || !credential.user?.isActive) return 'inactive';
        return { type: 'user', userId: credential.userId, credentialId: credential.id };
      case 'PROJECT':
      case 'AGENT':
        if (!credential.projectId || !credential.project || credential.project.archivedAt) return 'inactive';
        return {
          type: credential.kind === 'PROJECT' ? 'project' : 'agent',
          projectId: credential.projectId,
          organizationId: credential.project.organizationId,
          credentialId: credential.id,
        };
    }
  }

  /**
   * Whether a credential is still usable: not revoked, not expired, and (for project and
   * agent credentials) its project is not archived. Long-lived connections (agent
   * WebSockets, dashboard event streams) call this periodically, because they
   * authenticated once at connect time.
   */
  async isActive(credentialId: string, now = new Date()): Promise<boolean> {
    const credential = await this.prisma.apiCredential.findUnique({
      where: { id: credentialId },
      select: { revokedAt: true, expiresAt: true, kind: true, user: { select: { isActive: true } }, project: { select: { archivedAt: true } } },
    });
    if (!credential || credential.revokedAt) return false;
    if (credential.expiresAt && credential.expiresAt <= now) return false;
    if (credential.kind === 'USER') return credential.user?.isActive === true;
    return credential.project !== null && credential.project.archivedAt === null;
  }

  async issueUserToken(userId: string, ttlHours: number, db: Db = this.prisma): Promise<IssuedCredential> {
    const generated = generateToken('user');
    const credential = await db.apiCredential.create({
      data: {
        kind: 'USER',
        name: 'session',
        userId,
        tokenHash: generated.hash,
        displayPrefix: generated.displayPrefix,
        expiresAt: new Date(Date.now() + ttlHours * 3600_000),
      },
      select: credentialView,
    });
    return { credential, token: generated.token };
  }

  async createProjectCredential(
    input: { projectId: string; kind: 'PROJECT' | 'AGENT'; name: string; expiresAt?: Date | null; createdByUserId?: string | null },
    db: Db = this.prisma,
  ): Promise<IssuedCredential> {
    const generated = generateToken(TOKEN_BY_KIND[input.kind]);
    const credential = await db.apiCredential.create({
      data: {
        kind: input.kind,
        name: input.name,
        projectId: input.projectId,
        tokenHash: generated.hash,
        displayPrefix: generated.displayPrefix,
        expiresAt: input.expiresAt ?? null,
        createdByUserId: input.createdByUserId ?? null,
      },
      select: credentialView,
    });
    return { credential, token: generated.token };
  }

  listProjectCredentials(projectId: string, includeRevoked: boolean): Promise<CredentialView[]> {
    return this.prisma.apiCredential.findMany({
      where: { projectId, kind: { in: ['PROJECT', 'AGENT'] }, ...(includeRevoked ? {} : { revokedAt: null }) },
      select: credentialView,
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Issues a replacement credential and schedules the old one to expire after
   * `graceSeconds` (0 = revoke immediately), so deployed applications can be updated
   * without downtime. The old row is locked to make concurrent rotations safe: a
   * credential can be rotated at most once.
   */
  async rotate(
    projectId: string,
    credentialId: string,
    graceSeconds: number,
    actorUserId: string | null,
    db: Prisma.TransactionClient,
  ): Promise<IssuedCredential & { previous: CredentialView }> {
    const locked = await db.$queryRaw<{ id: string }[]>`
      SELECT id FROM api_credentials
      WHERE id = ${credentialId}::uuid AND project_id = ${projectId}::uuid AND kind IN ('PROJECT', 'AGENT')
      FOR UPDATE`;
    if (locked.length === 0) throw AppException.notFound('Credential');

    const current = await db.apiCredential.findUniqueOrThrow({
      where: { id: credentialId },
      select: { ...credentialView, rotatedTo: { select: { id: true } } },
    });
    const now = new Date();
    if (current.revokedAt || (current.expiresAt && current.expiresAt <= now)) {
      throw AppException.conflict('Credential is revoked or expired and cannot be rotated');
    }
    if (current.rotatedTo) throw AppException.conflict('Credential has already been rotated');

    const generated = generateToken(TOKEN_BY_KIND[current.kind]);
    const credential = await db.apiCredential.create({
      data: {
        kind: current.kind,
        name: current.name,
        projectId,
        tokenHash: generated.hash,
        displayPrefix: generated.displayPrefix,
        rotatedFromId: current.id,
        createdByUserId: actorUserId,
      },
      select: credentialView,
    });

    const graceEnd = new Date(now.getTime() + graceSeconds * 1000);
    const previous = await db.apiCredential.update({
      where: { id: current.id },
      data:
        graceSeconds === 0
          ? { revokedAt: now }
          : { expiresAt: current.expiresAt && current.expiresAt < graceEnd ? current.expiresAt : graceEnd },
      select: credentialView,
    });
    return { credential, token: generated.token, previous };
  }

  async revoke(where: { id: string; projectId?: string; userId?: string }, db: Db = this.prisma): Promise<CredentialView> {
    const existing = await db.apiCredential.findFirst({ where, select: credentialView });
    if (!existing) throw AppException.notFound('Credential');
    if (existing.revokedAt) return existing;
    return db.apiCredential.update({ where: { id: existing.id }, data: { revokedAt: new Date() }, select: credentialView });
  }

  /** Revokes every active project/agent credential of a project (used when archiving). */
  async revokeAllForProject(projectId: string, db: Db = this.prisma): Promise<number> {
    const result = await db.apiCredential.updateMany({
      where: { projectId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  private touch(id: string, lastUsedAt: Date | null, now: Date): void {
    if (lastUsedAt && now.getTime() - lastUsedAt.getTime() < LAST_USED_RESOLUTION_MS) return;
    this.prisma.apiCredential
      .update({ where: { id }, data: { lastUsedAt: now } })
      .catch((error: unknown) => this.logger.warn(`Failed to update lastUsedAt for credential ${id}: ${String(error)}`));
  }
}
