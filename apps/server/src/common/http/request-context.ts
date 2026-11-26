import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { OrgRole } from '@chronos/database';

/** The authenticated caller, resolved by AuthGuard from the bearer token. */
export type Principal =
  | { type: 'user'; userId: string; credentialId: string }
  | { type: 'project'; projectId: string; organizationId: string; credentialId: string }
  | { type: 'agent'; projectId: string; organizationId: string; credentialId: string };

export type PrincipalType = Principal['type'];

/** Organization (and optionally project) a request operates on, resolved by RolesGuard. */
export interface AccessScope {
  organizationId: string;
  projectId?: string;
  /** Role of a user principal. Undefined for project/agent principals. */
  role?: OrgRole;
}

export interface ChronosRequest extends Request {
  id: string;
  principal?: Principal;
  scope?: AccessScope;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** Accept a caller-supplied request id only if it is short and log-safe. */
export function sanitizeRequestId(value: unknown): string | undefined {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value) ? value : undefined;
}

/**
 * Assigns `req.id` before any other middleware: a log-safe caller-supplied
 * X-Request-Id is honoured, otherwise a UUID is generated. The id is echoed back in
 * the response header and in every response envelope.
 */
export function requestIdMiddleware(request: Request, response: Response, next: NextFunction): void {
  const id = sanitizeRequestId(request.headers['x-request-id']) ?? randomUUID();
  (request as ChronosRequest).id = id;
  response.setHeader('X-Request-Id', id);
  next();
}

/**
 * API responses can contain bearer tokens (login, credential creation) and private
 * job data: forbid caching by browsers and proxies, and MIME sniffing. The dashboard's
 * static files set their own headers and are not affected (they are served before
 * reaching the API prefix and override Cache-Control).
 */
export function apiSecurityHeaders(request: Request, response: Response, next: NextFunction): void {
  if (request.path.startsWith('/v1/') || request.path.startsWith('/health/')) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
  }
  next();
}

export function clientIp(request: Request): string | undefined {
  return request.ip ?? request.socket?.remoteAddress ?? undefined;
}
