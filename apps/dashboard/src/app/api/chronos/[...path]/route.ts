import { apiBaseUrl, clearSession, errorResponse, isSameOriginMutation, readSessionToken } from '@/lib/server/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Authenticated pass-through to the Chronos REST API and the dashboard event stream.
 * Browser → /api/chronos/v1/... → CHRONOS_API_URL/v1/... with the session token.
 *
 * Only API paths are forwarded. Sign-in, bootstrap and the agent WebSocket are excluded:
 * they have dedicated handlers or must never be reached through a user session.
 */
const BLOCKED = [/^v1\/auth\/(login|logout)$/, /^v1\/bootstrap(\/|$)/, /^v1\/agent\//];
const ALLOWED = [/^v1\/[A-Za-z0-9._~\-/]+$/, /^health\/(live|ready)$/];
const PASS_HEADERS = ['content-type', 'retry-after', 'x-request-id', 'cache-control'];

async function forward(request: Request, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await context.params;
  let joined: string;
  try {
    joined = path.map((segment) => encodeURIComponent(decodeURIComponent(segment))).join('/');
  } catch {
    return errorResponse(400, 'BAD_REQUEST', 'Malformed path');
  }
  if (!ALLOWED.some((pattern) => pattern.test(joined)) || BLOCKED.some((pattern) => pattern.test(joined)) || joined.includes('..')) {
    return errorResponse(404, 'NOT_FOUND', 'Not found');
  }
  const mutating = request.method !== 'GET' && request.method !== 'HEAD';
  if (mutating && !isSameOriginMutation(request)) return errorResponse(403, 'FORBIDDEN', 'Cross-site request rejected');

  const isHealth = joined.startsWith('health/');
  const token = await readSessionToken();
  if (!token && !isHealth) return errorResponse(401, 'UNAUTHORIZED', 'Not signed in');

  const search = new URL(request.url).search;
  const headers: Record<string, string> = {};
  if (token && !isHealth) headers.Authorization = `Bearer ${token}`;
  const contentType = request.headers.get('content-type');
  if (contentType) headers['Content-Type'] = contentType;
  const accept = request.headers.get('accept');
  if (accept) headers.Accept = accept;
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) headers['X-Forwarded-For'] = forwardedFor;

  let upstream: Response;
  try {
    upstream = await fetch(`${apiBaseUrl()}/${joined}${search}`, {
      method: request.method,
      headers,
      ...(mutating ? { body: await request.text() } : {}),
      cache: 'no-store',
      signal: request.signal,
    });
  } catch {
    return errorResponse(502, 'SERVICE_UNAVAILABLE', 'The Chronos API is unreachable');
  }

  if (upstream.status === 401 && !isHealth) await clearSession();
  const responseHeaders = new Headers();
  for (const name of PASS_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  if (upstream.headers.get('content-type')?.startsWith('text/event-stream')) {
    responseHeaders.set('Cache-Control', 'no-cache, no-transform');
    responseHeaders.set('X-Accel-Buffering', 'no');
  }
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

export { forward as GET, forward as POST, forward as PATCH, forward as DELETE };
