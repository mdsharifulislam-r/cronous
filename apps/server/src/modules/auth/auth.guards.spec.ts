import 'reflect-metadata';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import type { ChronosRequest, Principal } from '../../common/http/request-context';
import { AppException } from '../../common/http/app-exception';
import { ALLOWED_PRINCIPALS, IS_PUBLIC, REQUIRED_ROLE } from './auth.decorators';
import type { RateLimitService } from './rate-limit.service';
import { AuthGuard, extractBearerToken } from './auth.guard';
import type { CredentialsService } from './credentials.service';
import { RolesGuard } from './roles.guard';
import { canManageRole, roleSatisfies } from './roles';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const OTHER_PROJECT = '33333333-3333-4333-8333-333333333333';

function contextFor(request: Partial<ChronosRequest>, metadata: Record<string, unknown> = {}) {
  const handler = () => undefined;
  class TestController {}
  for (const [key, value] of Object.entries(metadata)) Reflect.defineMetadata(key, value, handler);
  return {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => TestController,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function statusOf(error: unknown): number {
  return error instanceof AppException ? error.getStatus() : -1;
}

describe('extractBearerToken', () => {
  it('parses well-formed headers only', () => {
    expect(extractBearerToken('Bearer chr_u_abc')).toBe('chr_u_abc');
    expect(extractBearerToken('bearer   chr_u_abc ')).toBe('chr_u_abc');
    expect(extractBearerToken('Basic abc')).toBeNull();
    expect(extractBearerToken('Bearer a b')).toBeNull();
    expect(extractBearerToken(undefined)).toBeNull();
  });
});

describe('AuthGuard', () => {
  const userPrincipal: Principal = { type: 'user', userId: 'u1', credentialId: 'c1' };

  function guardWith(principal: Principal | null) {
    const resolve = vi.fn().mockResolvedValue(principal);
    const credentials = { resolve, resolveWithReason: vi.fn(async (token: string) => ({ principal: await resolve(token), reason: principal ? null : 'unknown' })) } as unknown as CredentialsService;
    const rateLimit = { recordAuthFailure: vi.fn().mockResolvedValue(undefined) } as unknown as RateLimitService;
    return { guard: new AuthGuard(new Reflector(), credentials, rateLimit), credentials, rateLimit };
  }

  it('lets public routes through without a token', async () => {
    const { guard, credentials } = guardWith(null);
    await expect(guard.canActivate(contextFor({ headers: {} }, { [IS_PUBLIC]: true }))).resolves.toBe(true);
    expect(credentials.resolve).not.toHaveBeenCalled();
  });

  it('rejects missing and invalid tokens with 401', async () => {
    const { guard } = guardWith(null);
    await expect(guard.canActivate(contextFor({ headers: {} }))).rejects.toSatisfy((e) => statusOf(e) === 401);
    await expect(
      guard.canActivate(contextFor({ headers: { authorization: 'Bearer chr_u_bad' } })),
    ).rejects.toSatisfy((e) => statusOf(e) === 401);
  });

  it('attaches the principal for valid user tokens', async () => {
    const { guard } = guardWith(userPrincipal);
    const request: Partial<ChronosRequest> = { headers: { authorization: 'Bearer chr_u_ok' } };
    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.principal).toEqual(userPrincipal);
  });

  it('rejects machine credentials on user-only routes, and accepts them where allowed', async () => {
    const agent: Principal = { type: 'agent', projectId: PROJECT, organizationId: ORG, credentialId: 'c2' };
    const { guard } = guardWith(agent);
    const headers = { authorization: 'Bearer chr_a_ok' };
    await expect(guard.canActivate(contextFor({ headers }))).rejects.toSatisfy((e) => statusOf(e) === 403);
    await expect(guard.canActivate(contextFor({ headers }, { [ALLOWED_PRINCIPALS]: ['agent'] }))).resolves.toBe(true);
  });
});

describe('RolesGuard', () => {
  function guardWith(options: { role?: string | null; project?: { id: string; organizationId: string; archivedAt: Date | null } | null }) {
    const prisma = {
      membership: { findUnique: vi.fn().mockResolvedValue(options.role ? { role: options.role } : null) },
      project: { findUnique: vi.fn().mockResolvedValue(options.project ?? null) },
    } as unknown as PrismaService;
    return new RolesGuard(new Reflector(), prisma);
  }

  const user: Principal = { type: 'user', userId: 'u1', credentialId: 'c1' };

  it('allows routes without a role requirement', async () => {
    await expect(guardWith({}).canActivate(contextFor({ principal: user, params: {} }))).resolves.toBe(true);
  });

  it('returns 404 to non-members and 403 to members with insufficient role', async () => {
    const meta = { [REQUIRED_ROLE]: 'ADMIN' };
    await expect(
      guardWith({ role: null }).canActivate(contextFor({ principal: user, params: { orgId: ORG } }, meta)),
    ).rejects.toSatisfy((e) => statusOf(e) === 404);
    await expect(
      guardWith({ role: 'MEMBER' }).canActivate(contextFor({ principal: user, params: { orgId: ORG } }, meta)),
    ).rejects.toSatisfy((e) => statusOf(e) === 403);
  });

  it('attaches the scope for sufficient roles', async () => {
    const request: Partial<ChronosRequest> = { principal: user, params: { orgId: ORG } };
    await expect(guardWith({ role: 'OWNER' }).canActivate(contextFor(request, { [REQUIRED_ROLE]: 'ADMIN' }))).resolves.toBe(true);
    expect(request.scope).toEqual({ organizationId: ORG, role: 'OWNER' });
  });

  it('treats malformed ids and archived projects as not found', async () => {
    const meta = { [REQUIRED_ROLE]: 'VIEWER' };
    await expect(
      guardWith({ role: 'OWNER' }).canActivate(contextFor({ principal: user, params: { orgId: 'nope' } }, meta)),
    ).rejects.toSatisfy((e) => statusOf(e) === 404);
    const archived = { id: PROJECT, organizationId: ORG, archivedAt: new Date() };
    await expect(
      guardWith({ role: 'OWNER', project: archived }).canActivate(contextFor({ principal: user, params: { projectId: PROJECT } }, meta)),
    ).rejects.toSatisfy((e) => statusOf(e) === 404);
  });

  it('confines machine credentials to their own project and to MEMBER privileges', async () => {
    const project = { id: PROJECT, organizationId: ORG, archivedAt: null };
    const machine: Principal = { type: 'project', projectId: PROJECT, organizationId: ORG, credentialId: 'c3' };
    const foreign: Principal = { ...machine, projectId: OTHER_PROJECT };

    await expect(
      guardWith({ project }).canActivate(contextFor({ principal: machine, params: { projectId: PROJECT } }, { [REQUIRED_ROLE]: 'MEMBER' })),
    ).resolves.toBe(true);
    await expect(
      guardWith({ project }).canActivate(contextFor({ principal: machine, params: { projectId: PROJECT } }, { [REQUIRED_ROLE]: 'ADMIN' })),
    ).rejects.toSatisfy((e) => statusOf(e) === 403);
    await expect(
      guardWith({ project }).canActivate(contextFor({ principal: foreign, params: { projectId: PROJECT } }, { [REQUIRED_ROLE]: 'VIEWER' })),
    ).rejects.toSatisfy((e) => statusOf(e) === 404);
    await expect(
      guardWith({}).canActivate(contextFor({ principal: machine, params: { orgId: ORG } }, { [REQUIRED_ROLE]: 'VIEWER' })),
    ).rejects.toSatisfy((e) => statusOf(e) === 404);
  });

  it('fails closed when a role-protected route has no scope parameter', async () => {
    await expect(
      guardWith({ role: 'OWNER' }).canActivate(contextFor({ principal: user, params: {} }, { [REQUIRED_ROLE]: 'VIEWER' })),
    ).rejects.toThrow(/needs :orgId or :projectId/);
  });
});

describe('role helpers', () => {
  it('orders roles', () => {
    expect(roleSatisfies('OWNER', 'ADMIN')).toBe(true);
    expect(roleSatisfies('ADMIN', 'ADMIN')).toBe(true);
    expect(roleSatisfies('MEMBER', 'ADMIN')).toBe(false);
    expect(roleSatisfies('VIEWER', 'VIEWER')).toBe(true);
  });

  it('prevents admins from managing owners', () => {
    expect(canManageRole('OWNER', 'OWNER')).toBe(true);
    expect(canManageRole('ADMIN', 'MEMBER')).toBe(true);
    expect(canManageRole('ADMIN', 'OWNER')).toBe(false);
    expect(canManageRole('MEMBER', 'VIEWER')).toBe(false);
  });
});
