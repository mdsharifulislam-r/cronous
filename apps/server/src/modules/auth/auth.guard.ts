import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppException } from '../../common/http/app-exception';
import type { ChronosRequest, PrincipalType } from '../../common/http/request-context';
import { ALLOWED_PRINCIPALS, IS_PUBLIC } from './auth.decorators';
import { CredentialsService } from './credentials.service';
import { RateLimitService } from './rate-limit.service';
import { clientIp } from '../../common/http/request-context';

const DEFAULT_ALLOWED: PrincipalType[] = ['user'];

export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}

/**
 * Global authentication guard. Every route requires a valid bearer credential unless
 * marked `@Public()`. Fails closed: unknown, revoked, expired, wrong-kind tokens are all
 * rejected with the same 401 to avoid leaking which condition applied.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly credentials: CredentialsService,
    private readonly rateLimit: RateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const request = context.switchToHttp().getRequest<ChronosRequest>();
    const token = extractBearerToken(request.headers.authorization);
    if (!token) throw AppException.unauthorized();

    const { principal, reason } = await this.credentials.resolveWithReason(token);
    if (!principal) {
      // Only unknown tokens count towards the per-address lockout: expired sessions are
      // normal (and many users may share one address, e.g. behind the dashboard server).
      if (reason === 'unknown') await this.rateLimit.recordAuthFailure(clientIp(request));
      throw AppException.unauthorized('Invalid or expired credential');
    }

    const allowed = this.reflector.getAllAndOverride<PrincipalType[]>(ALLOWED_PRINCIPALS, targets) ?? DEFAULT_ALLOWED;
    if (!allowed.includes(principal.type)) {
      throw AppException.forbidden(`This endpoint does not accept ${principal.type} credentials`);
    }

    request.principal = principal;
    return true;
  }
}
