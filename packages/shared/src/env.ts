import { z } from 'zod';

/**
 * Parses boolean-like environment strings. Only explicit values are accepted so
 * that typos such as "ture" fail validation instead of silently becoming false.
 */
export const envBoolean = (defaultValue: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .optional()
    .transform((value) => (value === undefined ? defaultValue : ['true', '1', 'yes'].includes(value)));

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

/**
 * Validates `env` against `schema`. Empty strings are treated as unset, which
 * matches how docker compose passes `VAR=` lines. Values are never echoed in errors
 * because many of them are secrets.
 */
export function parseEnv<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  env: Record<string, string | undefined> = process.env,
): z.output<TSchema> {
  const normalized: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    normalized[key] = value === '' ? undefined : value;
  }
  const result = schema.safeParse(normalized);
  if (!result.success) {
    const issues = result.error.issues.map((issue: z.ZodIssue) => {
      const path = issue.path.join('.') || '(root)';
      return `${path}: ${issue.message}`;
    });
    throw new EnvValidationError(issues);
  }
  return result.data;
}
