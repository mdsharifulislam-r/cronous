import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChronosAdmin } from './admin';
import { ChronosConfigError, ChronosConflictError, ChronosRequestError, ChronosWaitTimeoutError } from './errors';
import { HttpClient } from './http';

type Call = { method: string; url: URL; body: unknown; auth: string | null };

/** Replaces fetch with a router; records every call. */
function mockFetch(route: (call: Call) => { status: number; body?: unknown; headers?: Record<string, string> } | Error) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL | string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      const call: Call = { method: init.method ?? 'GET', url: new URL(String(input)), body: init.body ? JSON.parse(String(init.body)) : undefined, auth: headers.get('authorization') };
      calls.push(call);
      const answer = route(call);
      if (answer instanceof Error) throw answer;
      return new Response(answer.status === 204 ? null : JSON.stringify(answer.body ?? {}), { status: answer.status, headers: answer.headers ?? {} });
    }),
  );
  return calls;
}

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const ok = (data: unknown) => ({ status: 200, body: { data } });
const identity = ok({ kind: 'PROJECT', projectId: PROJECT_ID, projectSlug: 'shop', organizationId: 'o', timezone: 'UTC', credentialId: 'c' });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('HttpClient', () => {
  const client = (server = 'http://chronos.test', maxAttempts = 3) =>
    new HttpClient({ server, token: () => 'chr_p_x', missingTokenMessage: 'no token', userAgent: 'test', maxAttempts });

  it('keeps a base path, converts ws(s) URLs and drops empty query values', async () => {
    const calls = mockFetch(() => ok([]));
    await client('wss://chronos.test/prefix').request('GET', '/v1/x', { query: { a: 1, b: undefined, c: '', d: false } });
    expect(calls[0]!.url.toString()).toBe('https://chronos.test/prefix/v1/x?a=1&d=false');
    expect(calls[0]!.auth).toBe('Bearer chr_p_x');
    expect(() => client('ftp://x')).toThrow(ChronosConfigError);
  });

  it('does not repeat a non-idempotent request after a network error', async () => {
    const calls = mockFetch(() => new TypeError('socket hang up'));
    await expect(client().request('POST', '/v1/x', { body: {} })).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
    expect(calls).toHaveLength(1);
  });

  it('retries idempotent requests after network errors and 502', async () => {
    let n = 0;
    const calls = mockFetch(() => (++n === 1 ? new TypeError('reset') : n === 2 ? { status: 502 } : ok({ fine: true })));
    expect(await client().request('GET', '/v1/x')).toEqual({ fine: true });
    expect(calls).toHaveLength(3);
  });

  it('retries any request on 429 and 503, honouring Retry-After', async () => {
    vi.useFakeTimers();
    let n = 0;
    const calls = mockFetch(() => (++n === 1 ? { status: 429, headers: { 'retry-after': '2' }, body: { error: { code: 'TOO_MANY_REQUESTS' } } } : ok('done')));
    const pending = client().request('POST', '/v1/x', { body: {} });
    await vi.advanceTimersByTimeAsync(1_900);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(await pending).toBe('done');
    expect(calls).toHaveLength(2);
  });

  it('maps error envelopes to typed errors and returns undefined for 204', async () => {
    mockFetch((call) => (call.method === 'DELETE' ? { status: 204 } : { status: 409, body: { error: { code: 'CONFLICT', message: 'exists', details: { a: 1 } } } }));
    await expect(client().request('POST', '/v1/x')).rejects.toMatchObject({ name: 'ChronosConflictError', status: 409, code: 'CONFLICT', message: 'exists', details: { a: 1 } });
    await expect(client().request('POST', '/v1/x')).rejects.toBeInstanceOf(ChronosConflictError);
    expect(await client().request('DELETE', '/v1/x')).toBeUndefined();
  });

  it('requires a token', async () => {
    const noToken = new HttpClient({ server: 'http://x', token: () => undefined, missingTokenMessage: 'set it', userAgent: 't' });
    await expect(noToken.request('GET', '/v1/x')).rejects.toThrow('set it');
  });
});

describe('ChronosAdmin', () => {
  const admin = () => new ChronosAdmin({ server: 'http://chronos.test', project: 'shop', token: 'chr_p_key', maxAttempts: 1 });

  it('resolves the project once and checks the slug', async () => {
    const calls = mockFetch((call) => (call.url.pathname === '/v1/identity' ? identity : ok([])));
    const client = admin();
    await client.jobs.list();
    await client.queues.list();
    expect(calls.map((call) => call.url.pathname)).toEqual(['/v1/identity', `/v1/projects/${PROJECT_ID}/jobs`, `/v1/projects/${PROJECT_ID}/queues`]);
    await expect(new ChronosAdmin({ server: 'http://chronos.test', project: 'other', token: 'chr_p_key' }).jobs.list()).rejects.toBeInstanceOf(ChronosConfigError);
  });

  it('addresses jobs by name, caching the id', async () => {
    const calls = mockFetch((call) => {
      if (call.url.pathname === '/v1/identity') return identity;
      if (call.url.pathname.endsWith('/jobs')) return ok([{ id: JOB_ID, name: 'report' }, { id: 'x', name: 'report-2' }]);
      return ok({ id: JOB_ID, name: 'report' });
    });
    const client = admin();
    await client.jobs.pause('report');
    await client.jobs.get('report');
    await client.jobs.get(JOB_ID);
    expect(calls.map((call) => `${call.method} ${call.url.pathname}${call.url.search}`)).toEqual([
      'GET /v1/identity',
      `GET /v1/projects/${PROJECT_ID}/jobs?q=report`,
      `POST /v1/projects/${PROJECT_ID}/jobs/${JOB_ID}/pause`,
      `GET /v1/projects/${PROJECT_ID}/jobs/${JOB_ID}`,
      `GET /v1/projects/${PROJECT_ID}/jobs/${JOB_ID}`,
    ]);
  });

  it('builds execution filters', async () => {
    const calls = mockFetch((call) => (call.url.pathname === '/v1/identity' ? identity : ok({ items: [], nextCursor: null })));
    await admin().executions.list({ job: JOB_ID, status: ['FAILED', 'DEAD_LETTERED'], delayed: false, from: new Date('2026-01-01T00:00:00Z'), limit: 10 });
    expect(Object.fromEntries(calls[1]!.url.searchParams)).toEqual({ jobId: JOB_ID, status: 'FAILED,DEAD_LETTERED', delayed: 'false', from: '2026-01-01T00:00:00.000Z', limit: '10' });
  });

  it('iterates over all pages', async () => {
    mockFetch((call) => {
      if (call.url.pathname === '/v1/identity') return identity;
      return call.url.searchParams.get('cursor') ? ok({ items: [{ id: 'b' }], nextCursor: null }) : ok({ items: [{ id: 'a' }], nextCursor: 'next' });
    });
    const ids: string[] = [];
    for await (const execution of admin().executions.iterate()) ids.push(execution.id);
    expect(ids).toEqual(['a', 'b']);
  });

  it('waits for a terminal status and times out otherwise', async () => {
    let polls = 0;
    mockFetch((call) => (call.url.pathname === '/v1/identity' ? identity : ok({ id: 'e', status: ++polls < 3 ? 'RUNNING' : 'SUCCEEDED' })));
    expect((await admin().executions.wait('e', { intervalMs: 100 })).status).toBe('SUCCEEDED');
    expect(polls).toBe(3);

    mockFetch((call) => (call.url.pathname === '/v1/identity' ? identity : ok({ id: 'e', status: 'QUEUED' })));
    await expect(admin().executions.wait('e', { timeoutMs: 150, intervalMs: 100 })).rejects.toBeInstanceOf(ChronosWaitTimeoutError);
  });

  it('validates submissions locally and sends an idempotency key', async () => {
    const calls = mockFetch((call) =>
      call.url.pathname === '/v1/identity' ? identity : { status: 201, body: { data: { execution: { id: 'e', scheduledFor: '2026-01-01T00:00:00.000Z' }, created: true } } },
    );
    const queued = await admin().queue('report', { a: 1 }, { delay: 5000 });
    expect(queued.scheduledFor).toBeInstanceOf(Date);
    expect(calls[1]!.body).toMatchObject({ job: 'report', payload: { a: 1 }, delayMs: 5000, idempotencyKey: expect.stringMatching(/^sdk-/) });
    await expect(admin().queue('report', {}, { delay: -1 })).rejects.toBeInstanceOf(ChronosRequestError);
    await expect(admin().queueBatch([])).rejects.toBeInstanceOf(ChronosConfigError);
  });

  it('reads the token from CHRONOS_API_KEY', async () => {
    vi.stubEnv('CHRONOS_API_KEY', 'chr_p_env');
    const calls = mockFetch(() => identity);
    await new ChronosAdmin({ server: 'http://chronos.test', project: 'shop' }).identity();
    expect(calls[0]!.auth).toBe('Bearer chr_p_env');
    vi.unstubAllEnvs();
  });
});
