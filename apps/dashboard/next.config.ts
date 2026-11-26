import type { NextConfig } from 'next';

/**
 * The dashboard never talks to the Chronos API from the browser: its own route handlers
 * (src/app/api/*) call CHRONOS_API_URL with the session token kept in an httpOnly cookie.
 * The CSP therefore only needs 'self' for connections.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default config;
