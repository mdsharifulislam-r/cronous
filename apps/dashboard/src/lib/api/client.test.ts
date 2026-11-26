import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, UNAUTHORIZED_EVENT, api, buildQuery } from './client';

afterEach(() => vi.unstubAllGlobals());

describe('API client', () => {
  it('builds query strings, skipping empty values and joining arrays', () => {
    expect(buildQuery({ a: 1, b: undefined, c: '', d: ['FAILED', 'DEAD_LETTERED'], e: false, f: [] })).toBe('?a=1&d=FAILED%2CDEAD_LETTERED&e=false');
    expect(buildQuery({})).toBe('');
  });

  it('unwraps the data envelope and sends the CSRF header only on mutations', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ data: { ok: true }, meta: { requestId: 'r' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.get('/workers')).resolves.toEqual({ ok: true });
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/chronos/v1/workers');
    expect(fetchMock.mock.calls[0]![1].headers['x-chronos-csrf']).toBeUndefined();
    await api.post('/projects/p/queue', { job: 'x' });
    expect(fetchMock.mock.calls[1]![1].headers['x-chronos-csrf']).toBe('1');
    expect(fetchMock.mock.calls[1]![1].body).toBe('{"job":"x"}');
  });

  it('turns error envelopes into ApiError with field errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'VALIDATION_FAILED', message: 'Request validation failed', details: [{ path: 'payload.to', message: 'must match format "email"' }] }, meta: { requestId: 'req-1' } }), { status: 400 })));
    const error = (await api.post('/x', {}).catch((caught: unknown) => caught)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 400, code: 'VALIDATION_FAILED', requestId: 'req-1' });
    expect(error.fieldErrors).toEqual({ 'payload.to': 'must match format "email"' });
  });

  it('announces 401 responses so the app can sign out', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":{"code":"UNAUTHORIZED","message":"x"}}', { status: 401 })));
    const listener = vi.fn();
    window.addEventListener(UNAUTHORIZED_EVENT, listener);
    await api.get('/workers').catch(() => undefined);
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(UNAUTHORIZED_EVENT, listener);
  });

  it('reports network failures distinctly and reads Retry-After', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    await expect(api.get('/workers')).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":{"code":"TOO_MANY_REQUESTS","message":"x"}}', { status: 429, headers: { 'retry-after': '120' } })));
    await expect(api.post('/x')).rejects.toMatchObject({ retryAfterSeconds: 120 });
  });
});
