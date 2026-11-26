import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { proxy } from './proxy';

function request(path: string, cookie?: string) {
  return new NextRequest(`http://dashboard.test${path}`, cookie ? { headers: { cookie } } : {});
}

describe('route protection (proxy)', () => {
  it('redirects anonymous users to /login and keeps the destination', () => {
    const response = proxy(request('/jobs/abc?tab=logs'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://dashboard.test/login?next=%2Fjobs%2Fabc%3Ftab%3Dlogs');
  });

  it('lets anonymous users reach /login and /setup', () => {
    expect(proxy(request('/login')).headers.get('location')).toBeNull();
    expect(proxy(request('/setup')).headers.get('location')).toBeNull();
  });

  it('lets signed-in users through and sends them away from /login', () => {
    expect(proxy(request('/jobs', 'chronos_session=x')).headers.get('location')).toBeNull();
    expect(proxy(request('/login', 'chronos_session=x')).headers.get('location')).toBe('http://dashboard.test/');
  });
});
