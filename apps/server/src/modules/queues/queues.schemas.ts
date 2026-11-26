import { z } from 'zod';
import { concurrencyLimitSchema, prioritySchema, queueNameSchema } from '@chronos/protocol';

export const createQueueSchema = z
  .object({
    name: queueNameSchema,
    description: z.string().max(500).nullable().optional(),
    /** Executions admitted at once (QUEUED + RUNNING); null or omitted = unlimited. */
    concurrencyLimit: concurrencyLimitSchema.nullable().optional(),
    defaultPriority: prioritySchema.default(50),
  })
  .strict();
export type CreateQueueInput = z.infer<typeof createQueueSchema>;

export const updateQueueSchema = z
  .object({
    description: z.string().max(500).nullable(),
    concurrencyLimit: concurrencyLimitSchema.nullable(),
    defaultPriority: prioritySchema,
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'at least one field is required' });
export type UpdateQueueInput = z.infer<typeof updateQueueSchema>;

export const queueNameParam = queueNameSchema;
