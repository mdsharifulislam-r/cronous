import { Prisma, PrismaClient } from '@prisma/client';

export * from '@prisma/client';

/** PostgreSQL SQLSTATE / Prisma error helpers shared by every Chronos service. */
export function isUniqueViolation(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export function isNotFound(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}

export interface CreatePrismaClientOptions {
  url: string;
  logQueries?: boolean;
}

export function createPrismaClient(options: CreatePrismaClientOptions): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: options.url } },
    log: options.logQueries ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });
}

/** Row id of the singleton `system_state` record. */
export const SYSTEM_STATE_ID = 1;
