import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cookieStore = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (cookieStore.has(name) ? { name, value: cookieStore.get(name)! } : undefined),
    set: (name: string, value: string) => cookieStore.set(name, value),
    delete: (name: string) => cookieStore.delete(name),
  }),
}));

const { GET, POST } = await import('./route');
const TOKEN = 'chr_u_' + 'a'.repeat(43);
const params = (path: string) => ({ params: Promise.resolve({ path: path.split('/') }) });

describe('API proxy', () => {
  const upstream = vi.fn();
  beforeEach(() => {
    process.env.CHRONOS_API_URL = 'http://chronos.internal:8080';
    cookieStore.clear();
    upstream.mockReset();
    vi.stubGlobal('fetch', upstream);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('attaches the session token and forwards path and query', async () => {
    cookieStore.set('chronos_session', TOKEN);
    upstream.mockResolvedValue(new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'r1' } }));
    const response = await GET(new Request('http://dash.test/api/chronos/v1/projects/p/jobs?q=sync'), params('v1/projects/p/jobs'));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('r1');
    const [url, init] = upstream.mock.calls[0]!;
    expect(url).toBe('http://chronos.internal:8080/v1/projects/p/jobs?q=sync');
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('rejects calls without a session and never forwards them', async () => {
    const response = await GET(new Request('http://dash.test/api/chronos/v1/workers'), params('v1/workers'));
    expect(response.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('blocks the agent WebSocket, login and bootstrap paths', async () => {
    cookieStore.set('chronos_session', TOKEN);
    for (const path of ['v1/agent/ws', 'v1/agent/identity', 'v1/auth/login', 'v1/bootstrap', 'internal/thing']) {
      expect((await GET(new Request(`http://dash.test/api/chronos/${path}`), params(path))).status).toBe(404);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it('enforces the CSRF header on mutations', async () => {
    cookieStore.set('chronos_session', TOKEN);
    const blocked = await POST(new Request('http://dash.test/api/chronos/v1/projects/p/queue', { method: 'POST', body: '{}', headers: { host: 'dash.test' } }), params('v1/projects/p/queue'));
    expect(blocked.status).toBe(403);
    upstream.mockResolvedValue(new Response('{"data":{}}', { status: 201, headers: { 'content-type': 'application/json' } }));
    const allowed = await POST(
      new Request('http://dash.test/api/chronos/v1/projects/p/queue', { method: 'POST', body: '{"job":"x"}', headers: { host: 'dash.test', 'x-chronos-csrf': '1', 'content-type': 'application/json' } }),
      params('v1/projects/p/queue'),
    );
    expect(allowed.status).toBe(201);
    expect(upstream.mock.calls[0]![1].body).toBe('{"job":"x"}');
  });

  it('clears the session when the API answers 401', async () => {
    cookieStore.set('chronos_session', TOKEN);
    upstream.mockResolvedValue(new Response('{"error":{"code":"UNAUTHORIZED","message":"x"}}', { status: 401 }));
    const response = await GET(new Request('http://dash.test/api/chronos/v1/workers'), params('v1/workers'));
    expect(response.status).toBe(401);
    expect(cookieStore.has('chronos_session')).toBe(false);
  });

  it('reports an unreachable API as 502', async () => {
    cookieStore.set('chronos_session', TOKEN);
    upstream.mockRejectedValue(new TypeError('fetch failed'));
    expect((await GET(new Request('http://dash.test/api/chronos/v1/workers'), params('v1/workers'))).status).toBe(502);
  });
});
