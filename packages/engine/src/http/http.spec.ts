import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { httpConfigSchema, maskHttpConfig, restoreMaskedSecrets } from './http-config';
import { isRetryableStatus, signWebhook } from './http-executor';
import { DestinationGuard } from './ssrf';

describe('DestinationGuard', () => {
  const strict = new DestinationGuard({ allowPrivate: false, allowedCidrs: [] });
  const relaxed = new DestinationGuard({ allowPrivate: true, allowedCidrs: [] });

  it('always blocks loopback, link-local (cloud metadata) and reserved ranges', () => {
    for (const address of ['127.0.0.1', '127.1.2.3', '::1', '169.254.169.254', '0.0.0.0', 'fe80::1', '224.0.0.1', '::ffff:127.0.0.1', '::ffff:169.254.169.254']) {
      expect(relaxed.check(address), address).not.toBeNull();
    }
  });

  it('blocks private ranges only when configured', () => {
    for (const address of ['10.0.0.5', '172.16.3.4', '192.168.1.1', '100.64.0.1', 'fd00::1', '::ffff:10.0.0.1']) {
      expect(strict.check(address), address).toMatch(/private/);
      expect(relaxed.check(address), address).toBeNull();
    }
  });

  it('allows public addresses and explicit allowlist overrides', () => {
    expect(strict.check('93.184.216.34')).toBeNull();
    expect(strict.check('2606:4700::1111')).toBeNull();
    const sameHost = new DestinationGuard({ allowPrivate: false, allowedCidrs: ['127.0.0.1/32', '10.1.0.0/16'] });
    expect(sameHost.check('127.0.0.1')).toBeNull();
    expect(sameHost.check('127.0.0.2')).not.toBeNull();
    expect(sameHost.check('10.1.2.3')).toBeNull();
    expect(sameHost.check('10.2.0.1')).toMatch(/private/);
    expect(() => new DestinationGuard({ allowPrivate: false, allowedCidrs: ['nope/8'] })).toThrow(/Invalid CIDR/);
  });

  it('rejects hostnames that resolve to blocked addresses at lookup time', async () => {
    const result = await new Promise<{ error: Error | null }>((resolve) =>
      strict.lookup('localhost', { all: true }, (error) => resolve({ error })),
    );
    expect(result.error?.message).toMatch(/not allowed/);
  });
});

describe('webhook helpers', () => {
  it('signs timestamp and body with HMAC-SHA256', () => {
    const expected = createHmac('sha256', 'secret-secret-123').update('1700000000.{"a":1}').digest('hex');
    expect(signWebhook('secret-secret-123', 1700000000, '{"a":1}')).toBe(`t=1700000000,v1=${expected}`);
  });

  it('classifies retryable statuses', () => {
    expect([500, 502, 503, 408, 425, 429].every(isRetryableStatus)).toBe(true);
    expect([400, 401, 403, 404, 410, 422].some(isRetryableStatus)).toBe(false);
  });

  it('validates and masks webhook configuration', () => {
    expect(httpConfigSchema.safeParse({ url: 'https://x.example/hook', headers: { Host: 'evil' } }).success).toBe(false);
    expect(httpConfigSchema.safeParse({ url: 'https://x.example/hook', headers: { 'X-A': 'a\r\nInjected: 1' } }).success).toBe(false);
    const masked = maskHttpConfig({
      url: 'https://x.example/hook',
      headers: { Authorization: 'Bearer abc', 'X-Trace': 't' },
      auth: { type: 'basic', username: 'u', password: 'p' },
      signingSecret: 'sixteen-chars-ok!',
    }) as Record<string, unknown>;
    expect(JSON.stringify(masked)).not.toMatch(/Bearer abc|"p"|sixteen/);
    expect((masked.headers as Record<string, string>)['X-Trace']).toBe('t');
  });
});

describe('restoreMaskedSecrets', () => {
  const stored = httpConfigSchema.parse({
    url: 'https://example.com/hook',
    headers: { 'X-Api-Key': 'real-key', Accept: 'application/json' },
    auth: { type: 'bearer', token: 'real-token' },
    signingSecret: 'a-real-signing-secret',
  });

  it('round-trips a masked config without losing secrets', () => {
    const masked = httpConfigSchema.parse({ ...(maskHttpConfig(stored) as object), url: 'https://example.com/new' });
    const restored = restoreMaskedSecrets(masked, stored);
    expect(restored).toEqual({ config: { ...stored, url: 'https://example.com/new' } });
  });

  it('keeps new values that are not masked', () => {
    const next = httpConfigSchema.parse({ url: 'https://example.com/hook', auth: { type: 'bearer', token: 'rotated' }, signingSecret: 'another-long-secret!' });
    expect(restoreMaskedSecrets(next, stored)).toEqual({ config: { ...next } });
  });

  it('rejects masks that have no stored value', () => {
    const next = httpConfigSchema.parse({ url: 'https://example.com/hook', headers: { 'X-Other-Token': '********' } });
    expect(restoreMaskedSecrets(next, stored)).toEqual({ error: expect.stringContaining('X-Other-Token') });
    expect(restoreMaskedSecrets(httpConfigSchema.parse({ url: 'https://example.com', signingSecret: '********' }), null)).toHaveProperty('error');
    expect(restoreMaskedSecrets(httpConfigSchema.parse({ url: 'https://example.com', auth: { type: 'basic', username: 'u', password: '********' } }), stored)).toHaveProperty('error');
  });
});
