import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@chronos/database';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { Principal } from '../../common/http/request-context';

export interface AuditEntry {
  action: string;
  principal?: Principal | null;
  organizationId?: string | null;
  projectId?: string | null;
  targetType?: string;
  targetId?: string;
  metadata?: Prisma.InputJsonValue;
  requestId?: string;
  ipAddress?: string;
}

type Db = Prisma.TransactionClient | PrismaService;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records an audit entry. Pass the transaction client when the audited change is
   * transactional so the entry commits (or rolls back) together with it.
   */
  async record(entry: AuditEntry, db: Db = this.prisma): Promise<void> {
    const principal = entry.principal ?? null;
    await db.auditLog.create({
      data: {
        action: entry.action,
        organizationId: entry.organizationId ?? null,
        projectId: entry.projectId ?? null,
        actorType: principal === null ? 'SYSTEM' : principal.type === 'user' ? 'USER' : 'CREDENTIAL',
        actorId: principal === null ? null : principal.type === 'user' ? principal.userId : principal.credentialId,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        metadata: entry.metadata ?? Prisma.JsonNull,
        requestId: entry.requestId ?? null,
        ipAddress: entry.ipAddress ?? null,
      },
    });
    this.logger.log({ audit: entry.action, targetType: entry.targetType, targetId: entry.targetId, requestId: entry.requestId });
  }
}
