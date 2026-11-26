import 'server-only';
import { cookies } from 'next/headers';

/**
 * Server-side session handling. The Chronos API issues bearer tokens (chr_u_…, 12 h by
 * default, no refresh endpoint). The dashboard keeps the token in an httpOnly cookie so
 * browser JavaScript can never read it; only the dashboard's route handlers attach it to
 * API calls.
 */
export const SESSION_COOKIE = 'chronos_session';
/** Non-secret companion cookie the UI can read to warn before the session expires. */
export const SESSION_EXPIRY_COOKIE = 'chronos_session_expires';
/** Header every mutating request from the dashboard must carry (CSRF defence). */
export const CSRF_HEADER = 'x-chronos-csrf';

export function apiBaseUrl(): string {
  const value = process.env.CHRONOS_API_URL;
  if (!value) throw new Error('CHRONOS_API_URL is not set (e.g. http://127.0.0.1:8080)');
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('CHRONOS_API_URL must be an http(s) URL');
  return url.toString().replace(/\/+$/, '');
}

function secureCookies(): boolean {
  const flag = process.env.DASHBOARD_SECURE_COOKIES;
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return process.env.NODE_ENV === 'production';
}

export async function readSessionToken(): Promise<string | undefined> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  return token && /^chr_u_[A-Za-z0-9_-]{20,100}$/.test(token) ? token : undefined;
}

export async function writeSession(token: string, expiresAt: string): Promise<void> {
  const store = await cookies();
  const expires = new Date(expiresAt);
  const base = { path: '/', sameSite: 'lax' as const, secure: secureCookies(), expires };
  store.set(SESSION_COOKIE, token, { ...base, httpOnly: true });
  store.set(SESSION_EXPIRY_COOKIE, expires.toISOString(), { ...base, httpOnly: false });
}

export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  store.delete(SESSION_EXPIRY_COOKIE);
}

/**
 * Rejects cross-site state-changing requests. SameSite=Lax already withholds the cookie
 * from cross-site POSTs; requiring a custom header (which a cross-site form cannot set
 * without a CORS preflight we never grant) and a same-origin Origin header closes the rest.
 */
export function isSameOriginMutation(request: Request): boolean {
  if (request.headers.get(CSRF_HEADER) !== '1') return false;
  const origin = request.headers.get('origin');
  if (!origin) return true; // same-origin fetches from older browsers may omit it; the header check above still applies
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Calls the Chronos API from the server. */
export async function chronosFetch(path: string, init: RequestInit & { token?: string } = {}): Promise<Response> {
  const { token, headers, ...rest } = init;
  return fetch(`${apiBaseUrl()}${path}`, {
    ...rest,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers as Record<string, string> | undefined),
    },
    cache: 'no-store',
  });
}

/** JSON error in the same envelope shape as the Chronos API. */
export function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message }, meta: { requestId: 'dashboard', apiVersion: '1' } }, { status, headers: { 'Cache-Control': 'no-store' } });
}
