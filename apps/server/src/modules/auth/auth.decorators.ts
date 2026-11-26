import { ExecutionContext, SetMetadata, createParamDecorator } from '@nestjs/common';
import type { OrgRole } from '@chronos/database';
import type { AccessScope, ChronosRequest, Principal, PrincipalType } from '../../common/http/request-context';

export const IS_PUBLIC = 'chronos:isPublic';
export const ALLOWED_PRINCIPALS = 'chronos:allowedPrincipals';
export const REQUIRED_ROLE = 'chronos:requiredRole';

/** Skips authentication entirely (health checks, login, bootstrap). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * Principal types accepted by a route. Defaults to `['user']`: project and agent
 * credentials are rejected unless a route opts in explicitly.
 */
export const AllowPrincipals = (...types: PrincipalType[]) => SetMetadata(ALLOWED_PRINCIPALS, types);

/**
 * Minimum organization role. The organization is resolved from the `:orgId` or
 * `:projectId` route parameter; the guard fails closed if neither exists.
 */
export const RequireRole = (role: OrgRole) => SetMetadata(REQUIRED_ROLE, role);

export const CurrentPrincipal = createParamDecorator((_: unknown, context: ExecutionContext): Principal => {
  const principal = context.switchToHttp().getRequest<ChronosRequest>().principal;
  if (!principal) throw new Error('CurrentPrincipal used on a route without authentication');
  return principal;
});

export const CurrentScope = createParamDecorator((_: unknown, context: ExecutionContext): AccessScope => {
  const scope = context.switchToHttp().getRequest<ChronosRequest>().scope;
  if (!scope) throw new Error('CurrentScope used on a route without @RequireRole');
  return scope;
});

/** Extracts the authenticated user id, failing if the principal is not a user. */
export const CurrentUserId = createParamDecorator((_: unknown, context: ExecutionContext): string => {
  const principal = context.switchToHttp().getRequest<ChronosRequest>().principal;
  if (principal?.type !== 'user') throw new Error('CurrentUserId used on a route that accepts non-user principals');
  return principal.userId;
});
