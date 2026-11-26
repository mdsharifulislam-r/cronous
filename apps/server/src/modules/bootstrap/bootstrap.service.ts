import { resolveQueueId } from '@chronos/engine';
import { DEFAULT_QUEUE } from '@chronos/protocol';
import { HttpStatus, Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Prisma, SYSTEM_STATE_ID } from '@chronos/database';
import { generateToken, hashPassword, hashToken, safeEqualHex } from '@chronos/shared';
import { APP_CONFIG } from '../../config/config.module';
import { ServerEnv } from '../../config/env.schema';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AppException } from '../../common/http/app-exception';
import { AuditService } from '../audit/audit.service';
import { CredentialsService } from '../auth/credentials.service';
import type { RequestMeta } from '../auth/auth.service';
import type { BootstrapInput } from './bootstrap.schemas';

interface SystemStateRow {
  bootstrapped_at: Date | null;
  bootstrap_token_hash: string | null;
}

/**
 * First-time setup.
 *
 * Until the installation is bootstrapped, a single bootstrap token is valid. It is
 * either supplied by the operator (CHRONOS_BOOTSTRAP_TOKEN) or generated on first start
 * and printed once to the log. Only its hash is stored. A successful bootstrap creates
 * the first admin, organization, project and credentials in a single transaction and
 * permanently invalidates the bootstrap token. The token can never be used to call any
 * other endpoint or to run jobs.
 */
@Injectable()
export class BootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BootstrapService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialsService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: ServerEnv,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.ensureBootstrapToken();
  }

  /** Locks the singleton state row; every bootstrap state change goes through here. */
  private async lockState(tx: Prisma.TransactionClient): Promise<SystemStateRow> {
    await tx.$executeRaw`
      INSERT INTO system_state (id, created_at, updated_at) VALUES (${SYSTEM_STATE_ID}, now(), now())
      ON CONFLICT (id) DO NOTHING`;
    const rows = await tx.$queryRaw<SystemStateRow[]>`
      SELECT bootstrapped_at, bootstrap_token_hash FROM system_state WHERE id = ${SYSTEM_STATE_ID} FOR UPDATE`;
    const row = rows[0];
    if (!row) throw new Error('system_state row missing');
    return row;
  }

  async ensureBootstrapToken(): Promise<void> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const state = await this.lockState(tx);
      if (state.bootstrapped_at) return { kind: 'bootstrapped' as const };

      const configured = this.config.CHRONOS_BOOTSTRAP_TOKEN;
      if (configured) {
        const hash = hashToken(configured);
        if (state.bootstrap_token_hash !== hash) {
          await tx.systemState.update({ where: { id: SYSTEM_STATE_ID }, data: { bootstrapTokenHash: hash } });
        }
        return { kind: 'configured' as const };
      }
      if (state.bootstrap_token_hash) return { kind: 'pending' as const };

      const generated = generateToken('bootstrap');
      await tx.systemState.update({ where: { id: SYSTEM_STATE_ID }, data: { bootstrapTokenHash: generated.hash } });
      return { kind: 'generated' as const, token: generated.token };
    });

    switch (outcome.kind) {
      case 'bootstrapped':
        return;
      case 'configured':
        this.logger.warn('Installation is not bootstrapped. Call POST /v1/bootstrap with CHRONOS_BOOTSTRAP_TOKEN.');
        return;
      case 'pending':
        this.logger.warn(
          'Installation is not bootstrapped. Use the bootstrap token printed at first startup, ' +
            'or set CHRONOS_BOOTSTRAP_TOKEN and restart to replace it.',
        );
        return;
      case 'generated':
        // Printed exactly once, by the replica that generated it. Only the hash is stored.
        this.logger.warn(
          [
            'Installation is not bootstrapped. A one-time bootstrap token was generated:',
            '',
            `    ${outcome.token}`,
            '',
            'Call POST /v1/bootstrap with "Authorization: Bearer <token>". It becomes invalid after first use.',
          ].join('\n'),
        );
        return;
    }
  }

  async status(): Promise<{ bootstrapped: boolean }> {
    const state = await this.prisma.systemState.findUnique({
      where: { id: SYSTEM_STATE_ID },
      select: { bootstrappedAt: true },
    });
    return { bootstrapped: Boolean(state?.bootstrappedAt) };
  }

  async bootstrap(input: BootstrapInput, presentedToken: string | null, meta: RequestMeta) {
    if (!presentedToken) throw AppException.unauthorized('Bootstrap token required');
    // Hash outside the transaction: scrypt is deliberately slow and must not hold the row lock.
    const passwordHash = await hashPassword(input.admin.password);

    return this.prisma.$transaction(
      async (tx) => {
        const state = await this.lockState(tx);
        if (state.bootstrapped_at) {
          throw new AppException(HttpStatus.CONFLICT, 'ALREADY_BOOTSTRAPPED', 'Installation is already bootstrapped');
        }
        if (!state.bootstrap_token_hash || !safeEqualHex(hashToken(presentedToken), state.bootstrap_token_hash)) {
          throw AppException.unauthorized('Invalid bootstrap token');
        }

        const user = await tx.user.create({
          data: { email: input.admin.email, name: input.admin.name, passwordHash },
          select: { id: true, email: true, name: true },
        });
        const organization = await tx.organization.create({
          data: { name: input.organization.name, slug: input.organization.slug },
          select: { id: true, name: true, slug: true },
        });
        await tx.membership.create({ data: { organizationId: organization.id, userId: user.id, role: 'OWNER' } });
        const project = await tx.project.create({
          data: {
            organizationId: organization.id,
            name: input.project.name,
            slug: input.project.slug,
            timezone: input.project.timezone,
          },
          select: { id: true, name: true, slug: true, timezone: true },
        });

        await resolveQueueId(tx, project.id, DEFAULT_QUEUE);
        const projectKey = await this.credentials.createProjectCredential(
          { projectId: project.id, kind: 'PROJECT', name: 'default project key', createdByUserId: user.id },
          tx,
        );
        const agentToken = await this.credentials.createProjectCredential(
          { projectId: project.id, kind: 'AGENT', name: 'default agent token', createdByUserId: user.id },
          tx,
        );
        const userToken = await this.credentials.issueUserToken(user.id, this.config.CHRONOS_USER_TOKEN_TTL_HOURS, tx);

        await tx.systemState.update({
          where: { id: SYSTEM_STATE_ID },
          data: { bootstrappedAt: new Date(), bootstrapTokenHash: null },
        });
        await this.audit.record(
          {
            action: 'system.bootstrapped',
            principal: { type: 'user', userId: user.id, credentialId: userToken.credential.id },
            organizationId: organization.id,
            projectId: project.id,
            targetType: 'organization',
            targetId: organization.id,
            requestId: meta.requestId,
            ...(meta.ipAddress ? { ipAddress: meta.ipAddress } : {}),
          },
          tx,
        );

        return {
          user,
          organization,
          project,
          // Plaintext credentials are returned exactly once.
          credentials: {
            userToken: { token: userToken.token, expiresAt: userToken.credential.expiresAt },
            projectKey: { id: projectKey.credential.id, token: projectKey.token },
            agentToken: { id: agentToken.credential.id, token: agentToken.token },
          },
        };
      },
      // Concurrent attempts queue on the row lock; give them time to obtain a connection
      // so losers receive ALREADY_BOOTSTRAPPED instead of a transaction-start timeout.
      { timeout: 15_000, maxWait: 10_000 },
    );
  }
}
