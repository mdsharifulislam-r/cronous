import { z } from 'zod';

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;
/** Headers the HTTP client controls itself or that would enable request smuggling. */
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer', 'keep-alive', 'proxy-authorization']);
const SECRET_HEADER = /auth|token|key|secret|cookie|signature|password/i;

export const httpConfigSchema = z
  .object({
    url: z
      .string()
      .url()
      .max(2048)
      .refine((value) => /^https?:\/\//i.test(value), { message: 'must be an http or https URL' })
      .refine((value) => {
        const url = new URL(value);
        return url.username === '' && url.password === '';
      }, { message: 'must not embed credentials; use "auth" instead' }),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('POST'),
    headers: z
      .record(z.string().regex(HEADER_NAME, 'invalid header name'), z.string().max(4096).regex(/^[^\r\n]*$/, 'header values must not contain newlines'))
      .default({})
      .refine((headers) => Object.keys(headers).length <= 50, { message: 'at most 50 headers' })
      .refine((headers) => Object.keys(headers).every((name) => !FORBIDDEN_HEADERS.has(name.toLowerCase())), {
        message: `headers must not include ${[...FORBIDDEN_HEADERS].join(', ')}`,
      }),
    auth: z
      .discriminatedUnion('type', [
        z.object({ type: z.literal('bearer'), token: z.string().min(1).max(4096) }).strict(),
        z.object({ type: z.literal('basic'), username: z.string().min(1).max(256), password: z.string().max(1024) }).strict(),
      ])
      .optional(),
    /** When set, requests carry X-Chronos-Signature (HMAC-SHA256 over timestamp + body). */
    // The mask is accepted so a masked config can be sent back; restoreMaskedSecrets() resolves it.
    signingSecret: z.union([z.literal('********'), z.string().min(16).max(256)]).optional(),
  })
  .strict();

export type HttpConfig = z.infer<typeof httpConfigSchema>;
export type HttpConfigInput = z.input<typeof httpConfigSchema>;

const MASK = '********';

/** Copy safe to return from the API: credentials and secret-looking headers are masked. */
export function maskHttpConfig(config: unknown): unknown {
  const parsed = httpConfigSchema.safeParse(config);
  if (!parsed.success) return config === null ? null : { invalid: true };
  const value = parsed.data;
  return {
    url: value.url,
    method: value.method,
    headers: Object.fromEntries(Object.entries(value.headers).map(([name, header]) => [name, SECRET_HEADER.test(name) ? MASK : header])),
    ...(value.auth ? { auth: value.auth.type === 'bearer' ? { type: 'bearer', token: MASK } : { type: 'basic', username: value.auth.username, password: MASK } } : {}),
    ...(value.signingSecret ? { signingSecret: MASK } : {}),
  };
}

export const SECRET_MASK = MASK;

/**
 * Lets clients round-trip a masked configuration (as returned by `maskHttpConfig`):
 * every secret still equal to the mask is replaced by the currently stored value, so
 * editing a webhook's URL in a form does not overwrite its credentials with "********".
 * Returns an error message when a masked value has no stored counterpart to restore.
 */
export function restoreMaskedSecrets(next: HttpConfig, stored: unknown): { config: HttpConfig } | { error: string } {
  const previous = httpConfigSchema.safeParse(stored);
  const old = previous.success ? previous.data : undefined;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(next.headers)) {
    if (value !== MASK) {
      headers[name] = value;
      continue;
    }
    const kept = old && Object.entries(old.headers).find(([oldName]) => oldName.toLowerCase() === name.toLowerCase())?.[1];
    if (kept === undefined) return { error: `header "${name}" is masked but no stored value exists; send the real value` };
    headers[name] = kept;
  }

  let auth = next.auth;
  if (auth?.type === 'bearer' && auth.token === MASK) {
    if (old?.auth?.type !== 'bearer') return { error: 'auth.token is masked but no stored bearer token exists' };
    auth = { type: 'bearer', token: old.auth.token };
  } else if (auth?.type === 'basic' && auth.password === MASK) {
    if (old?.auth?.type !== 'basic') return { error: 'auth.password is masked but no stored basic credentials exist' };
    auth = { type: 'basic', username: auth.username, password: old.auth.password };
  }

  let signingSecret = next.signingSecret;
  if (signingSecret === MASK) {
    if (!old?.signingSecret) return { error: 'signingSecret is masked but no stored secret exists' };
    signingSecret = old.signingSecret;
  }

  return {
    config: { ...next, headers, ...(auth ? { auth } : {}), ...(signingSecret !== undefined ? { signingSecret } : {}) },
  };
}
