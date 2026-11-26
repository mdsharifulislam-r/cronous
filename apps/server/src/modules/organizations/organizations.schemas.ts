import { z } from 'zod';
import { displayNameSchema, emailSchema, passwordSchema, slugSchema } from '@chronos/shared';

const orgRoleSchema = z.enum(['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']);

export const createOrganizationSchema = z.object({ name: displayNameSchema, slug: slugSchema }).strict();
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

export const updateOrganizationSchema = z
  .object({ name: displayNameSchema })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'at least one field is required' });
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;

/**
 * Adds an existing user by email, or creates the user when `name` and `password` are
 * supplied. Self-hosted installs have no email delivery, so the admin sets an initial
 * password and shares it out-of-band.
 */
export const addMemberSchema = z
  .object({
    email: emailSchema,
    role: orgRoleSchema,
    name: displayNameSchema.optional(),
    password: passwordSchema.optional(),
  })
  .strict()
  .refine((value) => (value.name === undefined) === (value.password === undefined), {
    message: 'name and password must be provided together when creating a new user',
    path: ['password'],
  });
export type AddMemberInput = z.infer<typeof addMemberSchema>;

export const updateMemberSchema = z.object({ role: orgRoleSchema }).strict();
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;
