import { NextResponse, type NextRequest } from 'next/server';

/**
 * Route protection. Pages require the session cookie; its validity is checked by the API
 * on every call (a 401 sends the user back to /login). Auth pages redirect signed-in users.
 */
const SESSION_COOKIE = 'chronos_session';
const PUBLIC_PAGES = ['/login', '/setup'];

export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const hasSession = request.cookies.has(SESSION_COOKIE);
  const isPublic = PUBLIC_PAGES.some((page) => pathname === page || pathname.startsWith(`${page}/`));

  if (!hasSession && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }
  if (hasSession && pathname === '/login') {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    url.search = '';
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // Everything except API routes, Next internals and static files.
  matcher: ['/((?!api/|_next/|favicon.ico|icon.svg|robots.txt).*)'],
};
