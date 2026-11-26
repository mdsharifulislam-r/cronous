import { z } from 'zod';
import { displayNameSchema, slugSchema, timeZoneSchema } from '@chronos/shared';
import { MAX_ROTATION_GRACE_SECONDS } from '../auth/credentials.service';

export const createProjectSchema = z
  .object({ name: displayNameSchema, slug: slugSchema, timezone: timeZoneSchema.default('UTC') })
  .strict();
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = z
  .object({ name: displayNameSchema, timezone: timeZoneSchema })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'at least one field is required' });
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

export const createCredentialSchema = z
  .object({
    kind: z.enum(['PROJECT', 'AGENT']),
    name: z.string().trim().min(1).max(80),
    expiresInDays: z.number().int().min(1).max(3650).optional(),
  })
  .strict();
export type CreateCredentialInput = z.infer<typeof createCredentialSchema>;

export const rotateCredentialSchema = z
  .object({
    /** How long the old token keeps working; 0 revokes it immediately. */
    gracePeriodSeconds: z.number().int().min(0).max(MAX_ROTATION_GRACE_SECONDS).default(3600),
  })
  .strict();
export type RotateCredentialInput = z.infer<typeof rotateCredentialSchema>;

export const listCredentialsQuerySchema = z
  .object({ includeRevoked: z.enum(['true', 'false']).default('false').transform((value) => value === 'true') })
  .strict();
