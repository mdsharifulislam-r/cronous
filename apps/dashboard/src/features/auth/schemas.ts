import { z } from 'zod';

/** Mirrors the server's rules (packages/shared/src/validation.ts). */
export const slugSchema = z
  .string()
  .min(2, 'At least 2 characters')
  .max(48)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Lowercase letters and digits, separated by single hyphens');

export const passwordSchema = z.string().min(12, 'At least 12 characters').max(256);

export const loginSchema = z.object({
  email: z.string().trim().email('Enter a valid email'),
  password: z.string().min(1, 'Enter your password'),
});
export type LoginValues = z.infer<typeof loginSchema>;

export const setupSchema = z.object({
  bootstrapToken: z.string().trim().min(16, 'Paste the bootstrap token from the server log'),
  adminName: z.string().trim().min(1, 'Required').max(120),
  adminEmail: z.string().trim().email('Enter a valid email'),
  adminPassword: passwordSchema,
  orgName: z.string().trim().min(1, 'Required').max(120),
  orgSlug: slugSchema,
  projectName: z.string().trim().min(1, 'Required').max(120),
  projectSlug: slugSchema,
  timezone: z.string().min(1),
});
export type SetupValues = z.infer<typeof setupSchema>;

export function slugify(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}
