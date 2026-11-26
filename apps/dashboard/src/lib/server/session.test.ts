import { describe, expect, it } from 'vitest';
import { isSameOriginMutation } from './session';

const make = (headers: Record<string, string>) => new Request('http://dashboard.test/api/x', { method: 'POST', headers });

describe('CSRF protection', () => {
  it('requires the custom header', () => {
    expect(isSameOriginMutation(make({ host: 'dashboard.test' }))).toBe(false);
    expect(isSameOriginMutation(make({ host: 'dashboard.test', 'x-chronos-csrf': '1' }))).toBe(true);
  });

  it('rejects a foreign Origin even with the header', () => {
    expect(isSameOriginMutation(make({ host: 'dashboard.test', 'x-chronos-csrf': '1', origin: 'https://evil.example' }))).toBe(false);
    expect(isSameOriginMutation(make({ host: 'dashboard.test', 'x-chronos-csrf': '1', origin: 'http://dashboard.test' }))).toBe(true);
  });

  it('honours X-Forwarded-Host behind a reverse proxy', () => {
    expect(isSameOriginMutation(make({ host: 'internal:3000', 'x-forwarded-host': 'chronos.example.com', 'x-chronos-csrf': '1', origin: 'https://chronos.example.com' }))).toBe(true);
  });
});
