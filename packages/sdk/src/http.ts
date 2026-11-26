import {
  ChronosAuthError,
  ChronosConfigError,
  ChronosConflictError,
  ChronosNotFoundError,
  ChronosRequestError,
  ChronosValidationError,
} from './errors';

export interface HttpClientOptions {
  server: string;
  /** Called per request, so a token from the environment can change between calls. */
  token: () => string | undefined;
  /** Message of the error thrown when `token()` returns nothing. */
  missingTokenMessage: string;
  userAgent: string;
  /** Attempts per request, including the first (default 5). */
  maxAttempts?: number;
  /** Per-attempt timeout in ms (default 10 000). */
  requestTimeoutMs?: number;
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  /**
   * The request can safely be repeated (GET, or a submission with an idempotency key).
   * Idempotent requests are retried after network errors and 502/504; others only after
   * 429 and 503, which mean the server did not process them.
   */
  idempotent?: boolean;
}

/** Answers that mean "not processed, try again later". */
const ALWAYS_RETRY = new Set([429, 503]);
/** Answers after which the request may or may not have been processed. */
const RETRY_IF_IDEMPOTENT = new Set([502, 504]);

/** Minimal JSON client for the Chronos REST API: envelopes, typed errors and retries. */
export class HttpClient {
  private readonly base: string;

  constructor(private readonly options: HttpClientOptions) {
    let url: URL;
    try {
      url = new URL(options.server);
    } catch {
      throw new ChronosConfigError(`"server" must be an http(s) URL, got "${options.server}"`);
    }
    // The agent accepts ws(s):// URLs for the same server; REST uses the matching http(s).
    if (url.protocol === 'ws:') url.protocol = 'http:';
    else if (url.protocol === 'wss:') url.protocol = 'https:';
    else if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ChronosConfigError(`"server" must be an http(s) URL, got "${options.server}"`);
    url.search = '';
    url.hash = '';
    if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
    this.base = url.toString();
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const token = this.options.token();
    if (!token) throw new ChronosConfigError(this.options.missingTokenMessage);
    const url = new URL(path.replace(/^\//, ''), this.base);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    const idempotent = options.idempotent ?? method === 'GET';
    const attempts = Math.max(1, this.options.maxAttempts ?? 5);
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            'User-Agent': this.options.userAgent,
            ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
          signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 10_000),
        });
      } catch (error) {
        lastError = new ChronosRequestError(`Request to Chronos failed: ${error instanceof Error ? error.message : String(error)}`, 0, 'NETWORK_ERROR');
        if (!idempotent) throw lastError;
        await backoff(attempt, attempts);
        continue;
      }
      if (response.status === 204) return undefined as T;
      const json = (await response.json().catch(() => ({}))) as { data?: T; error?: { code?: string; message?: string; details?: unknown } };
      if (response.ok) return json.data as T;
      const error = toError(response.status, json.error);
      const retryable = ALWAYS_RETRY.has(response.status) || (idempotent && RETRY_IF_IDEMPOTENT.has(response.status));
      if (!retryable) throw error;
      lastError = error;
      const retryAfter = Number(response.headers.get('retry-after'));
      await backoff(attempt, attempts, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined);
    }
    throw lastError;
  }
}

async function backoff(attempt: number, attempts: number, overrideMs?: number): Promise<void> {
  if (attempt >= attempts) return;
  const delay = overrideMs ?? Math.min(5_000, 200 * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2);
  await new Promise((resolve) => setTimeout(resolve, delay));
}

export function toError(status: number, error: { code?: string; message?: string; details?: unknown } | undefined): ChronosRequestError {
  const code = error?.code ?? 'HTTP_ERROR';
  const message = error?.message ?? `Chronos responded with HTTP ${status}`;
  if (status === 400) return new ChronosValidationError(message, status, code, error?.details);
  if (status === 401 || status === 403) return new ChronosAuthError(message, status, code, error?.details);
  if (status === 404) return new ChronosNotFoundError(message, status, code, error?.details);
  if (status === 409) return new ChronosConflictError(message, status, code, error?.details);
  return new ChronosRequestError(message, status, code, error?.details);
}
