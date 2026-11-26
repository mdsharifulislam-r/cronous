import { z } from 'zod';
import { isValidTimeZone } from './timezone';

export const slugSchema = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be lowercase alphanumeric words separated by single hyphens');

export const timeZoneSchema = z.string().refine(isValidTimeZone, { message: 'must be a valid IANA time zone' });

export const emailSchema = z
  .string()
  .trim()
  .max(254)
  .email()
  .transform((value) => value.toLowerCase());

/** NIST 800-63B style: length over composition rules. */
export const passwordSchema = z.string().min(12, 'must be at least 12 characters').max(256);

export const displayNameSchema = z.string().trim().min(1).max(120);
