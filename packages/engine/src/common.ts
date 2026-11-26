import type { Prisma, PrismaClient } from '@chronos/database';

export type Db = PrismaClient | Prisma.TransactionClient;

/** Structured logger accepted by every engine component (pino, Nest, console adapters). */
export interface EngineLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export const silentLogger: EngineLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * The PostgreSQL clock. Scheduling decisions use it instead of the host clock so that
 * clock skew between scheduler hosts cannot cause early, late or duplicate firing.
 */
export async function dbNow(db: Db): Promise<Date> {
  const rows = await db.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  const now = rows[0]?.now;
  if (!now) throw new Error('SELECT now() returned no rows');
  return now;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Truncates text stored in the database (error messages, response bodies). */
export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 15)}… [truncated]`;
}

/** Resolves after `ms`, or immediately when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
