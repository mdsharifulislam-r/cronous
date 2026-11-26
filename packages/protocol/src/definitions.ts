import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';

/**
 * Job definition schemas shared by the REST API and the SDK. Validation lives here so
 * the SDK rejects a bad definition at registration time with the same rules the server
 * applies.
 */

export const JOB_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const jobNameSchema = z
  .string()
  .regex(JOB_NAME_PATTERN, 'must start with a letter or digit and contain only letters, digits, ".", "_", ":" or "-" (max 128)');

function isValidZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone.length > 0 && timeZone.length <= 64;
  } catch {
    return false;
  }
}

export const timeZoneNameSchema = z.string().refine(isValidZone, { message: 'must be a valid IANA time zone' });

export const cronExpressionSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .superRefine((value, ctx) => {
    if (value.split(/\s+/).length !== 5) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must have exactly 5 fields (minute hour day-of-month month day-of-week)' });
      return;
    }
    try {
      CronExpressionParser.parse(value, { tz: 'UTC' });
    } catch (error) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid cron expression: ${error instanceof Error ? error.message : String(error)}` });
    }
  });

/**
 * Queue names identify admission lanes ("default", "emails"). They are deliberately a
 * different shape from job names (lowercase, no ":"), so the two are never confused.
 */
export const QUEUE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
export const queueNameSchema = z.string().regex(QUEUE_NAME_PATTERN, 'must be lowercase letters, digits, "_" or "-" (max 63), starting with a letter or digit');
export const DEFAULT_QUEUE = 'default';

/** 0-100; higher is dispatched first among waiting executions of the same queue. */
export const prioritySchema = z.number().int().min(0).max(100);

/** Executions admitted at once (QUEUED + RUNNING). */
export const concurrencyLimitSchema = z.number().int().min(1).max(100_000);

const MAX_SCHEMA_BYTES = 32 * 1024;
/** A JSON Schema (draft 2020-12) object. Compiled and checked by the server. */
export const payloadJsonSchemaSchema = z
  .record(z.string(), z.unknown())
  .refine((value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_SCHEMA_BYTES, { message: `payload schema exceeds ${MAX_SCHEMA_BYTES} bytes` });

/** Longest accepted delay for delayed submissions. */
export const MAX_DELAY_MS = 365 * 86_400_000;

export const misfirePolicySchema = z.enum(['FIRE_ONCE', 'SKIP', 'FIRE_ALL']);
export const concurrencyPolicySchema = z.enum(['ALLOW', 'FORBID']);

const MAX_PAYLOAD_BYTES = 64 * 1024;

/** Arbitrary JSON payload, size-limited so it cannot bloat execution rows. */
export const jsonPayloadSchema = z.unknown().superRefine((value, ctx) => {
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'payload must be JSON-serialisable' });
    return;
  }
  if (size > MAX_PAYLOAD_BYTES) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `payload exceeds ${MAX_PAYLOAD_BYTES} bytes` });
});

export const scheduleDefinitionSchema = z
  .object({
    cron: cronExpressionSchema.optional(),
    runAt: z.coerce.date().optional(),
    /** Defaults to the project's time zone on the server. */
    timezone: timeZoneNameSchema.optional(),
    misfirePolicy: misfirePolicySchema.default('FIRE_ONCE'),
    misfireGraceMs: z.number().int().min(0).max(86_400_000).default(60_000),
    maxCatchUp: z.number().int().min(1).max(1000).default(10),
  })
  .strict()
  .refine((value) => (value.cron === undefined) !== (value.runAt === undefined), {
    message: 'exactly one of "cron" or "runAt" is required',
  });

export type ScheduleDefinition = z.infer<typeof scheduleDefinitionSchema>;

/** Execution settings common to every mode. */
export const executionSettingsSchema = z.object({
  timeoutMs: z.number().int().min(1000).max(86_400_000).default(300_000),
  maxAttempts: z.number().int().min(1).max(100).default(3),
  retryBackoffMs: z.number().int().min(0).max(86_400_000).default(10_000),
  retryBackoffMaxMs: z.number().int().min(0).max(7 * 86_400_000).default(3_600_000),
  concurrencyPolicy: concurrencyPolicySchema.default('ALLOW'),
});

/**
 * What the SDK sends for each `chronos.task(...)` during the agent handshake. Agent
 * jobs carry no HTTP config: the handler lives in the application process.
 */
export const agentTaskDefinitionSchema = executionSettingsSchema
  .extend({
    name: jobNameSchema,
    description: z.string().max(500).optional(),
    schedule: scheduleDefinitionSchema.nullable().default(null),
    /** Admission lane; created on first use when it does not exist yet. */
    queue: queueNameSchema.optional(),
    priority: prioritySchema.optional(),
    maxConcurrency: concurrencyLimitSchema.optional(),
    payloadSchema: payloadJsonSchemaSchema.optional(),
  })
  .strict()
  .refine((value) => value.retryBackoffMaxMs >= value.retryBackoffMs, {
    message: 'retryBackoffMaxMs must be >= retryBackoffMs',
    path: ['retryBackoffMaxMs'],
  });

export type AgentTaskDefinition = z.infer<typeof agentTaskDefinitionSchema>;
export type AgentTaskDefinitionInput = z.input<typeof agentTaskDefinitionSchema>;

/**
 * One submission of a job for immediate or delayed execution (REST `POST /queue` and the
 * SDK's `chronos.queue()`). `job` is the job NAME; `queue` optionally overrides the job's
 * queue. Without `delayMs`/`runAt` the execution is due immediately.
 */
export const queueSubmissionSchema = z
  .object({
    job: jobNameSchema,
    payload: jsonPayloadSchema.optional(),
    delayMs: z.number().int().min(0).max(MAX_DELAY_MS).optional(),
    runAt: z.coerce.date().optional(),
    priority: prioritySchema.optional(),
    queue: queueNameSchema.optional(),
    /** Repeating a submission with the same key returns the original execution. */
    idempotencyKey: z.string().min(1).max(200).regex(/^[!-~]+$/, 'printable ASCII without spaces').optional(),
    maxAttempts: z.number().int().min(1).max(100).optional(),
    retryBackoffMs: z.number().int().min(0).max(86_400_000).optional(),
    retryBackoffMaxMs: z.number().int().min(0).max(7 * 86_400_000).optional(),
    timeoutMs: z.number().int().min(1000).max(86_400_000).optional(),
  })
  .strict()
  .refine((value) => value.delayMs === undefined || value.runAt === undefined, { message: 'use either "delayMs" or "runAt", not both', path: ['runAt'] })
  .refine((value) => value.runAt === undefined || value.runAt.getTime() <= Date.now() + MAX_DELAY_MS, { message: 'runAt is too far in the future (max 365 days)', path: ['runAt'] });

export type QueueSubmission = z.infer<typeof queueSubmissionSchema>;
export type QueueSubmissionInput = z.input<typeof queueSubmissionSchema>;

export const MAX_BATCH_SUBMISSIONS = 100;
export const queueBatchSchema = z.object({ items: z.array(queueSubmissionSchema).min(1).max(MAX_BATCH_SUBMISSIONS) }).strict();
