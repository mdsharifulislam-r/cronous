import { z } from 'zod';
import { envBoolean, isValidNamespace, parseEnv } from '@chronos/shared';

const urlWithScheme = (schemes: string[]) =>
  z
    .string()
    .url()
    .refine((value) => schemes.some((scheme) => value.startsWith(`${scheme}://`)), {
      message: `must use one of the schemes: ${schemes.join(', ')}`,
    });

export const serverEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    LOG_PRETTY: envBoolean(false),

    DATABASE_URL: urlWithScheme(['postgres', 'postgresql']),
    REDIS_URL: urlWithScheme(['redis', 'rediss']),
    /** Prefix for every Redis key and BullMQ queue owned by Chronos. */
    CHRONOS_NAMESPACE: z
      .string()
      .default('chronos')
      .refine(isValidNamespace, { message: 'must match ^[a-z][a-z0-9_-]{0,31}$' }),

    /**
     * Optional operator-supplied bootstrap token. When unset and the installation is not
     * bootstrapped yet, the server generates one and prints it once at startup.
     */
    CHRONOS_BOOTSTRAP_TOKEN: z.string().min(32, 'must be at least 32 characters').max(256).optional(),
    CHRONOS_USER_TOKEN_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(12),
    CHRONOS_LOGIN_MAX_FAILURES: z.coerce.number().int().min(1).max(1000).default(10),
    CHRONOS_LOGIN_LOCKOUT_SECONDS: z.coerce.number().int().min(10).max(86400).default(900),

    /** Trust X-Forwarded-* headers. Enable only behind a reverse proxy you control. */
    CHRONOS_TRUST_PROXY: envBoolean(false),
    CHRONOS_CORS_ORIGINS: z
      .string()
      .optional()
      .transform((value) =>
        value
          ? value
              .split(',')
              .map((origin) => origin.trim())
              .filter(Boolean)
          : [],
      ),
    // --- Scheduling engine -------------------------------------------------------------
    /** Run the scheduler/dispatcher/reaper loop inside this server process. */
    CHRONOS_EMBEDDED_SCHEDULER: envBoolean(true),
    /** Run an HTTP-webhook worker inside this server process (Mode A without extra containers). */
    CHRONOS_EMBEDDED_WORKER: envBoolean(true),
    CHRONOS_SCHEDULER_TICK_MS: z.coerce.number().int().min(100).max(60000).default(1000),
    CHRONOS_LEASE_MS: z.coerce.number().int().min(5000).max(600000).default(30000),
    CHRONOS_EXECUTION_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(30),
    CHRONOS_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(1000).default(10),
    // --- Agents ----------------------------------------------------------------------
    CHRONOS_AGENT_HEARTBEAT_MS: z.coerce.number().int().min(1000).max(120000).default(10000),
    /**
     * How often long-lived connections (agent WebSockets, dashboard event streams)
     * re-validate their credential, so revocation takes effect without reconnecting.
     */
    // --- Rate limiting (Redis, shared by all replicas; fixed 60 s windows) -----------
    CHRONOS_RATE_LIMIT_ENABLED: envBoolean(true),
    /** Requests per minute per bearer token (users, project keys, agent tokens). */
    CHRONOS_RATE_LIMIT_PER_TOKEN_PER_MINUTE: z.coerce.number().int().min(1).max(1_000_000).default(1200),
    /** Requests per minute per client IP without a token (login, bootstrap). */
    CHRONOS_RATE_LIMIT_ANONYMOUS_PER_MINUTE: z.coerce.number().int().min(1).max(1_000_000).default(120),
    /** Rejected credentials per minute per client IP before that IP is refused outright. */
    CHRONOS_RATE_LIMIT_AUTH_FAILURES_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(30),
    CHRONOS_CREDENTIAL_RECHECK_MS: z.coerce.number().int().min(1000).max(600000).default(30000),
    // --- Dashboard real-time events -----------------------------------------------------
    /** Change-feed polling interval for the dashboard event stream (only while clients are connected). */
    CHRONOS_EVENTS_POLL_MS: z.coerce.number().int().min(250).max(60000).default(1000),
    /** Maximum concurrent dashboard event streams per server process. */
    CHRONOS_EVENTS_MAX_STREAMS: z.coerce.number().int().min(1).max(100000).default(500),
    // --- Webhooks (Mode A) -------------------------------------------------------------
    /** Allow webhook targets in private ranges (10/8, 172.16/12, 192.168/16, fc00::/7). */
    CHRONOS_WEBHOOK_ALLOW_PRIVATE: envBoolean(true),
    /** Comma-separated CIDRs always allowed, e.g. "127.0.0.1/32" for a same-host app. */
    CHRONOS_WEBHOOK_ALLOWED_CIDRS: z.string().optional().transform((value) => (value ? value.split(',').map((cidr) => cidr.trim()).filter(Boolean) : [])),
    /** Serve the web dashboard at /dashboard. */
    CHRONOS_DASHBOARD_ENABLED: envBoolean(true),
    CHRONOS_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(15000),
    CHRONOS_READINESS_TIMEOUT_MS: z.coerce.number().int().min(100).max(30000).default(2000),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.LOG_PRETTY) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['LOG_PRETTY'], message: 'must be false in production' });
    }
  });

export type ServerEnv = z.output<typeof serverEnvSchema>;

export function loadServerEnv(env: Record<string, string | undefined> = process.env): ServerEnv {
  return parseEnv(serverEnvSchema, env);
}
