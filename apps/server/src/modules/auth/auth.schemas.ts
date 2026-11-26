import { z } from 'zod';
import { displayNameSchema, emailSchema, passwordSchema } from '@chronos/shared';

export const loginSchema = z
  .object({
    email: emailSchema,
    // Length-capped but not strength-checked: policy applies when passwords are set.
    password: z.string().min(1).max(256),
  })
  .strict();

export type LoginInput = z.infer<typeof loginSchema>;

export const updateProfileSchema = z.object({ name: displayNameSchema }).strict();
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(256),
    newPassword: passwordSchema,
  })
  .strict()
  .refine((value) => value.currentPassword !== value.newPassword, {
    message: 'must differ from the current password',
    path: ['newPassword'],
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
