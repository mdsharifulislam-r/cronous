import { z } from 'zod';
import { displayNameSchema, emailSchema, passwordSchema, slugSchema, timeZoneSchema } from '@chronos/shared';

export const bootstrapSchema = z
  .object({
    admin: z.object({ email: emailSchema, name: displayNameSchema, password: passwordSchema }).strict(),
    organization: z.object({ name: displayNameSchema, slug: slugSchema }).strict(),
    project: z.object({ name: displayNameSchema, slug: slugSchema, timezone: timeZoneSchema.default('UTC') }).strict(),
  })
  .strict();

export type BootstrapInput = z.infer<typeof bootstrapSchema>;
