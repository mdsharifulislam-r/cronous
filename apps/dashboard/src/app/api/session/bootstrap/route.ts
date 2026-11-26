import { z } from 'zod';
import { chronosFetch, errorResponse, isSameOriginMutation, writeSession } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

/** Whether the installation still needs its one-time setup. */
export async function GET(): Promise<Response> {
  const upstream = await chronosFetch('/v1/bootstrap/status');
  return new Response(upstream.body, { status: upstream.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

const setupSchema = z
  .object({
    bootstrapToken: z.string().min(16).max(256),
    admin: z.object({ email: z.string(), name: z.string(), password: z.string() }).strict(),
    organization: z.object({ name: z.string(), slug: z.string() }).strict(),
    project: z.object({ name: z.string(), slug: z.string(), timezone: z.string() }).strict(),
  })
  .strict();

/**
 * One-time setup. Creates the admin, organization and first project, signs the admin in,
 * and returns the project API key and agent token exactly once for the user to copy.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginMutation(request)) return errorResponse(403, 'FORBIDDEN', 'Cross-site request rejected');
  const parsed = setupSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, 'VALIDATION_FAILED', 'Invalid setup request');
  const { bootstrapToken, ...body } = parsed.data;

  const upstream = await chronosFetch('/v1/bootstrap', {
    method: 'POST',
    token: bootstrapToken,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await upstream.json().catch(() => null)) as {
    data?: {
      user: unknown;
      organization: { id: string };
      project: { id: string };
      credentials: { userToken: { token: string; expiresAt: string }; projectKey: { id: string; token: string }; agentToken: { id: string; token: string } };
    };
  } | null;
  if (!upstream.ok || !json?.data) {
    return new Response(JSON.stringify(json ?? {}), { status: upstream.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }
  const { credentials, ...rest } = json.data;
  await writeSession(credentials.userToken.token, credentials.userToken.expiresAt);
  return Response.json(
    { data: { ...rest, credentials: { projectKey: credentials.projectKey, agentToken: credentials.agentToken } } },
    { status: 201, headers: { 'Cache-Control': 'no-store' } },
  );
}
