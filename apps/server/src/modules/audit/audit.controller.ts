import { Controller, Get, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { Prisma } from '@chronos/database';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { ZodValidationPipe, uuidParam } from '../../common/http/zod-validation.pipe';
import { AppException } from '../../common/http/app-exception';
import { RequireRole } from '../auth/auth.decorators';

export const listAuditLogsQuerySchema = z
  .object({
    projectId: z.string().uuid().optional(),
    /** Exact action (`job.created`) or a prefix ending in a dot (`job.`). */
    action: z.string().regex(/^[a-z_]+(\.[a-z_]*)?$/).max(64).optional(),
    actorId: z.string().max(64).optional(),
    targetType: z.string().regex(/^[a-z_]+$/).max(32).optional(),
    targetId: z.string().max(64).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    /** Opaque cursor from a previous page's `nextCursor`. */
    cursor: z.string().regex(/^\d{1,19}$/).optional(),
  })
  .strict();
export type ListAuditLogsQuery = z.infer<typeof listAuditLogsQuerySchema>;

/**
 * Organization activity log. ADMIN only: entries contain client IP addresses and the
 * full history of credential and membership changes.
 */
@Controller('organizations/:orgId/audit-logs')
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequireRole('ADMIN')
  async list(@Param('orgId', uuidParam) orgId: string, @Query(new ZodValidationPipe(listAuditLogsQuerySchema)) query: ListAuditLogsQuery) {
    if (query.from && query.to && query.from > query.to) throw AppException.badRequest('"from" must not be after "to"');
    const where: Prisma.AuditLogWhereInput = {
      organizationId: orgId,
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.action ? (query.action.endsWith('.') ? { action: { startsWith: query.action } } : { action: query.action }) : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.targetType ? { targetType: query.targetType } : {}),
      ...(query.targetId ? { targetId: query.targetId } : {}),
      ...(query.from || query.to ? { createdAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } } : {}),
      ...(query.cursor ? { id: { lt: BigInt(query.cursor) } } : {}),
    };
    const rows = await this.prisma.auditLog.findMany({ where, orderBy: { id: 'desc' }, take: query.limit + 1 });
    const page = rows.slice(0, query.limit);

    // Resolve actor display names in two batched lookups.
    const userIds = [...new Set(page.filter((row) => row.actorType === 'USER' && row.actorId).map((row) => row.actorId!))];
    const credentialIds = [...new Set(page.filter((row) => row.actorType === 'CREDENTIAL' && row.actorId).map((row) => row.actorId!))];
    const [users, credentials] = await Promise.all([
      userIds.length ? this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }) : [],
      credentialIds.length
        ? this.prisma.apiCredential.findMany({ where: { id: { in: credentialIds } }, select: { id: true, name: true, kind: true, displayPrefix: true } })
        : [],
    ]);
    const userById = new Map(users.map((user) => [user.id, user]));
    const credentialById = new Map(credentials.map((credential) => [credential.id, credential]));

    const last = page[page.length - 1];
    return {
      items: page.map((row) => {
        const user = row.actorType === 'USER' && row.actorId ? userById.get(row.actorId) : undefined;
        const credential = row.actorType === 'CREDENTIAL' && row.actorId ? credentialById.get(row.actorId) : undefined;
        return {
          id: row.id.toString(),
          action: row.action,
          projectId: row.projectId,
          actor: {
            type: row.actorType,
            id: row.actorId,
            name: user?.name ?? credential?.name ?? null,
            email: user?.email ?? null,
            credentialKind: credential?.kind ?? null,
            credentialPrefix: credential?.displayPrefix ?? null,
          },
          targetType: row.targetType,
          targetId: row.targetId,
          metadata: row.metadata,
          requestId: row.requestId,
          ipAddress: row.ipAddress,
          createdAt: row.createdAt,
        };
      }),
      nextCursor: rows.length > query.limit && last ? last.id.toString() : null,
    };
  }
}
