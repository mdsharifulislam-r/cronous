import type { ApiEnvelope, ApiErrorBody } from '@/types/api';

/**
 * The only place that talks HTTP. Requests go to the dashboard's own server
 * (/api/chronos/... and /api/session), which attaches the session token; the browser
 * never holds a Chronos token.
 */

export const CSRF_HEADER = 'x-chronos-csrf';
export const UNAUTHORIZED_EVENT = 'chronos:unauthorized';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Field-level validation issues as `{ path: message }` (empty when not a validation error). */
  get fieldErrors(): Record<string, string> {
    if (!Array.isArray(this.details)) return {};
    const result: Record<string, string> = {};
    for (const issue of this.details as { path?: unknown; message?: unknown }[]) {
      if (typeof issue?.path === 'string' && typeof issue.message === 'string' && !(issue.path in result)) result[issue.path] = issue.message;
    }
    return result;
  }
}

export type QueryValue = string | number | boolean | undefined | null | readonly string[];

export function buildQuery(query?: Record<string, QueryValue>): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length > 0) params.set(key, value.join(','));
    } else {
      params.set(key, String(value));
    }
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  signal?: AbortSignal;
}

async function parse<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const json = (await response.json().catch(() => null)) as ApiEnvelope<T> | ApiErrorBody | null;
  if (response.ok && json && 'data' in json) return json.data;
  const error = json && 'error' in json ? json.error : undefined;
  const retryAfter = Number(response.headers.get('retry-after'));
  if (response.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  throw new ApiError(
    response.status,
    error?.code ?? (response.status >= 500 ? 'SERVICE_UNAVAILABLE' : 'HTTP_ERROR'),
    error?.message ?? `Request failed (HTTP ${response.status})`,
    error?.details,
    json && 'meta' in json ? json.meta?.requestId : undefined,
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
  );
}

export async function request<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, options: RequestOptions = {}): Promise<T> {
  const mutating = method !== 'GET';
  let response: Response;
  try {
    response = await fetch(`${url}${buildQuery(options.query)}`, {
      method,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(mutating ? { [CSRF_HEADER]: '1' } : {}),
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      cache: 'no-store',
    });
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error;
    throw new ApiError(0, 'NETWORK_ERROR', 'Network error: the dashboard server could not be reached');
  }
  return parse<T>(response);
}

/** Chronos REST API (v1) through the dashboard proxy. `path` starts with "/". */
export const api = {
  get: <T>(path: string, query?: Record<string, QueryValue>, signal?: AbortSignal) =>
    request<T>('GET', `/api/chronos/v1${path}`, { ...(query ? { query } : {}), ...(signal ? { signal } : {}) }),
  post: <T>(path: string, body?: unknown) => request<T>('POST', `/api/chronos/v1${path}`, body === undefined ? {} : { body }),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', `/api/chronos/v1${path}`, { body }),
  delete: <T = void>(path: string) => request<T>('DELETE', `/api/chronos/v1${path}`),
};

/** URL of the project event stream through the proxy (Server-Sent Events, same-origin cookie auth). */
export function eventStreamUrl(projectId: string): string {
  return `/api/chronos/v1/projects/${encodeURIComponent(projectId)}/events`;
}
