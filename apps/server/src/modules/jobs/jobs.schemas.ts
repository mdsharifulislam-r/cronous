import { z } from 'zod';
import {
  concurrencyLimitSchema,
  executionSettingsSchema,
  jobNameSchema,
  jsonPayloadSchema,
  payloadJsonSchemaSchema,
  prioritySchema,
  queueNameSchema,
  scheduleDefinitionSchema,
} from '@chronos/protocol';
import { httpConfigSchema } from '@chronos/engine';

const jobFields = executionSettingsSchema.extend({
  description: z.string().max(500).nullable().optional(),
  mode: z.enum(['HTTP', 'AGENT', 'WORKER']),
  enabled: z.boolean().default(true),
  http: httpConfigSchema.optional(),
  payload: jsonPayloadSchema.optional(),
  schedule: scheduleDefinitionSchema.nullable().default(null),
  /** Admission lane; must exist (except "default", created on first use). */
  queue: queueNameSchema.default('default'),
  /** Default priority of this job's executions (0-100); null = the queue's default. */
  priority: prioritySchema.nullable().optional(),
  /** Executions of this job admitted at once; null = no job-level limit. */
  maxConcurrency: concurrencyLimitSchema.nullable().optional(),
  /** JSON Schema (draft 2020-12) every payload must satisfy; null = no validation. */
  payloadSchema: payloadJsonSchemaSchema.nullable().optional(),
});

export const createJobSchema = jobFields
  .extend({ name: jobNameSchema })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.mode === 'HTTP') !== (value.http !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['http'], message: '"http" is required for HTTP jobs and only allowed for them' });
    }
    if (value.retryBackoffMaxMs < value.retryBackoffMs) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['retryBackoffMaxMs'], message: 'must be >= retryBackoffMs' });
    }
  });
export type CreateJobInput = z.infer<typeof createJobSchema>;

/** Every field optional; `schedule: null` removes the schedule. Name is immutable. */
export const updateJobSchema = z
  .object({
    description: z.string().max(500).nullable(),
    mode: z.enum(['HTTP', 'AGENT', 'WORKER']),
    enabled: z.boolean(),
    http: httpConfigSchema,
    payload: jsonPayloadSchema,
    schedule: scheduleDefinitionSchema.nullable(),
    timeoutMs: z.number().int().min(1000).max(86_400_000),
    maxAttempts: z.number().int().min(1).max(100),
    retryBackoffMs: z.number().int().min(0).max(86_400_000),
    retryBackoffMaxMs: z.number().int().min(0).max(7 * 86_400_000),
    concurrencyPolicy: z.enum(['ALLOW', 'FORBID']),
    queue: queueNameSchema,
    priority: prioritySchema.nullable(),
    maxConcurrency: concurrencyLimitSchema.nullable(),
    payloadSchema: payloadJsonSchemaSchema.nullable(),
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'at least one field is required' });
export type UpdateJobInput = z.infer<typeof updateJobSchema>;

export const triggerJobSchema = z
  .object({
    payload: jsonPayloadSchema.optional(),
    /** Repeating a trigger with the same key returns the original execution. */
    idempotencyKey: z.string().min(1).max(200).regex(/^[\x21-\x7e]+$/, 'printable ASCII without spaces').optional(),
  })
  .strict();
export type TriggerJobInput = z.infer<typeof triggerJobSchema>;

export const listJobsQuerySchema = z
  .object({
    mode: z.enum(['HTTP', 'AGENT', 'WORKER']).optional(),
    enabled: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
    source: z.enum(['API', 'SDK']).optional(),
    queue: queueNameSchema.optional(),
    /** Case-insensitive substring match on the job name or description. */
    q: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export type ListJobsQuery = z.infer<typeof listJobsQuerySchema>;

export const previewQuerySchema = z.object({ count: z.coerce.number().int().min(1).max(50).default(5) }).strict();
