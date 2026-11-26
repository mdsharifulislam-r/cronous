import { z } from 'zod';

const statuses = ['PENDING', 'QUEUED', 'RUNNING', 'RETRY_SCHEDULED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'DEAD_LETTERED'] as const;

export const listExecutionsQuerySchema = z
  .object({
    jobId: z.string().uuid().optional(),
    /** Comma-separated, e.g. `status=FAILED,DEAD_LETTERED`. */
    status: z
      .string()
      .transform((value) => value.split(',').map((part) => part.trim()))
      .pipe(z.array(z.enum(statuses)).min(1))
      .optional(),
    trigger: z.enum(['SCHEDULE', 'MANUAL', 'QUEUE']).optional(),
    /** Queue name. */
    queue: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/).optional(),
    /** Executions with at least one attempt run by this agent / worker. */
    agentId: z.string().uuid().optional(),
    workerId: z.string().uuid().optional(),
    /** true: only executions waiting for a future run time; false: exclude them. */
    delayed: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
    mode: z.enum(['HTTP', 'AGENT', 'WORKER']).optional(),
    /** Inclusive range on the execution's creation time (ISO 8601). */
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().max(200).optional(),
  })
  .strict()
  .refine((value) => !(value.from && value.to && value.from > value.to), { message: '"from" must not be after "to"', path: ['from'] });

export type ListExecutionsQuery = z.infer<typeof listExecutionsQuerySchema>;

export const statsQuerySchema = z
  .object({
    hours: z.coerce.number().int().min(1).max(24 * 30).default(24),
    jobId: z.string().uuid().optional(),
    /** Queue name: restrict to executions admitted through this queue. */
    queue: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/).optional(),
  })
  .strict();
export type StatsQuery = z.infer<typeof statsQuerySchema>;

export const timeseriesQuerySchema = z
  .object({
    hours: z.coerce.number().int().min(1).max(24 * 30).default(24),
    jobId: z.string().uuid().optional(),
    queue: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/).optional(),
    mode: z.enum(['HTTP', 'AGENT', 'WORKER']).optional(),
    bucket: z.enum(['hour', 'day']).default('hour'),
  })
  .strict();
export type TimeseriesQuery = z.infer<typeof timeseriesQuerySchema>;

export const listLogsQuerySchema = z
  .object({
    /** Return entries with an id greater than this (from a previous page's `nextAfterId`). */
    afterId: z.string().regex(/^\d{1,19}$/).optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(200),
  })
  .strict();
export type ListLogsQuery = z.infer<typeof listLogsQuerySchema>;
