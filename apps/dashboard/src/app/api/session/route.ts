import { z } from 'zod';
import { chronosFetch, clearSession, errorResponse, isSameOriginMutation, readSessionToken, writeSession } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

const loginSchema = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(256) }).strict();

/** Current user (GET /v1/auth/me) or 401. */
export async function GET(): Promise<Response> {
  const token = await readSessionToken();
  if (!token) return errorResponse(401, 'UNAUTHORIZED', 'Not signed in');
  const upstream = await chronosFetch('/v1/auth/me', { token });
  if (upstream.status === 401) await clearSession();
  return new Response(upstream.body, { status: upstream.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

/** Sign in: exchanges email/password for a Chronos session token stored in an httpOnly cookie. */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginMutation(request)) return errorResponse(403, 'FORBIDDEN', 'Cross-site request rejected');
  const parsed = loginSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, 'VALIDATION_FAILED', 'Enter a valid email and password');

  const forwardedFor = request.headers.get('x-forwarded-for');
  const upstream = await chronosFetch('/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {}) },
    body: JSON.stringify(parsed.data),
  });
  const body = (await upstream.json().catch(() => null)) as { data?: { token: string; expiresAt: string; user: unknown } } | null;
  if (!upstream.ok || !body?.data) {
    return new Response(JSON.stringify(body ?? {}), {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(upstream.headers.get('retry-after') ? { 'Retry-After': upstream.headers.get('retry-after')! } : {}) },
    });
  }
  await writeSession(body.data.token, body.data.expiresAt);
  // The token itself is never returned to the browser.
  return Response.json({ data: { user: body.data.user, expiresAt: body.data.expiresAt } }, { headers: { 'Cache-Control': 'no-store' } });
}

/** Sign out: revokes the token in Chronos and clears the cookies. */
export async function DELETE(request: Request): Promise<Response> {
  if (!isSameOriginMutation(request)) return errorResponse(403, 'FORBIDDEN', 'Cross-site request rejected');
  const token = await readSessionToken();
  if (token) await chronosFetch('/v1/auth/logout', { method: 'POST', token }).catch(() => undefined);
  await clearSession();
  return new Response(null, { status: 204 });
}
