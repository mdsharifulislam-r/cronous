import type { NextFunction, Request, Response } from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  // Inline style attributes are set by the dashboard's DOM code (no inline scripts).
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

function resolveDashboardDir(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('@chronos/dashboard-lite') as { publicDir: string }).publicDir;
  } catch {
    return null;
  }
}

/** Serves the static dashboard at /dashboard with strict security headers. */
export function mountDashboard(app: NestExpressApplication): boolean {
  const dir = resolveDashboardDir();
  if (!dir) return false;
  app.use('/dashboard', (_request: Request, response: Response, next: NextFunction) => {
    response.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.useStaticAssets(dir, { prefix: '/dashboard/', index: 'index.html', maxAge: '5m', redirect: true });
  app.use((request: Request, response: Response, next: NextFunction) => {
    if (request.method === 'GET' && (request.path === '/' || request.path === '/dashboard')) return response.redirect(302, '/dashboard/');
    next();
  });
  return true;
}
