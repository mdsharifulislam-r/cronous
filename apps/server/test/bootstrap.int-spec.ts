import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { BootstrapService } from '../src/modules/bootstrap/bootstrap.service';
import { ADMIN, api, bearer, bootstrapInstallation, resetState, startTestApp } from './setup/test-app';
import { TEST_BOOTSTRAP_TOKEN } from './setup/test-env';

const body = {
  admin: ADMIN,
  organization: { name: 'Acme', slug: 'acme' },
  project: { name: 'Storefront', slug: 'storefront', timezone: 'Asia/Dhaka' },
};

describe('bootstrap flow', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await startTestApp();
  });

  beforeEach(async () => {
    await resetState(app);
    await app.get(BootstrapService).ensureBootstrapToken();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports status publicly', async () => {
    const response = await api(app).get('/v1/bootstrap/status').expect(200);
    expect(response.body.data).toEqual({ bootstrapped: false });
  });

  it('rejects a missing or wrong bootstrap token', async () => {
    await api(app).post('/v1/bootstrap').send(body).expect(401);
    await api(app).post('/v1/bootstrap').set(...bearer('chr_b_wrong-token-value-that-is-long-enough')).send(body).expect(401);
  });

  it('validates input before touching state', async () => {
    const response = await api(app)
      .post('/v1/bootstrap')
      .set(...bearer(TEST_BOOTSTRAP_TOKEN))
      .send({ ...body, project: { ...body.project, timezone: 'Mars/Olympus' } })
      .expect(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    const status = await api(app).get('/v1/bootstrap/status').expect(200);
    expect(status.body.data.bootstrapped).toBe(false);
  });

  it('creates the admin, organization, project and working credentials exactly once', async () => {
    const result = await bootstrapInstallation(app);
    expect(result.organization.slug).toBe('acme');
    expect(result.project.timezone).toBe('Asia/Dhaka');
    expect(result.credentials.projectKey.token).toMatch(/^chr_p_/);
    expect(result.credentials.agentToken.token).toMatch(/^chr_a_/);

    // The user token works for the management API.
    const me = await api(app).get('/v1/auth/me').set(...bearer(result.credentials.userToken.token)).expect(200);
    expect(me.body.data.organizations).toEqual([expect.objectContaining({ slug: 'acme', role: 'OWNER' })]);

    // The project key can read its own project but not user endpoints.
    await api(app).get(`/v1/projects/${result.project.id}`).set(...bearer(result.credentials.projectKey.token)).expect(200);
    await api(app).get('/v1/auth/me').set(...bearer(result.credentials.projectKey.token)).expect(403);
    // Agent tokens are only for the agent channel.
    await api(app).get(`/v1/projects/${result.project.id}`).set(...bearer(result.credentials.agentToken.token)).expect(403);

    // Plaintext tokens are never stored.
    const prisma = app.get(PrismaService);
    const stored = await prisma.apiCredential.findMany({ select: { tokenHash: true } });
    expect(stored.every((row) => /^[0-9a-f]{64}$/.test(row.tokenHash))).toBe(true);
    const state = await prisma.systemState.findUniqueOrThrow({ where: { id: 1 } });
    expect(state.bootstrapTokenHash).toBeNull();
    expect(state.bootstrappedAt).not.toBeNull();

    // The bootstrap token is single-use.
    const again = await api(app).post('/v1/bootstrap').set(...bearer(TEST_BOOTSTRAP_TOKEN)).send(body).expect(409);
    expect(again.body.error.code).toBe('ALREADY_BOOTSTRAPPED');
    await api(app).get('/v1/bootstrap/status').expect(200).expect((r) => expect(r.body.data.bootstrapped).toBe(true));

    const audit = await prisma.auditLog.findFirst({ where: { action: 'system.bootstrapped' } });
    expect(audit?.organizationId).toBe(result.organization.id);
  });

  it('lets exactly one of several concurrent bootstrap requests succeed', async () => {
    const attempts = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        api(app)
          .post('/v1/bootstrap')
          .set(...bearer(TEST_BOOTSTRAP_TOKEN))
          .send({ ...body, admin: { ...ADMIN, email: `admin${index}@example.com` } }),
      ),
    );
    const statuses = attempts.map((response) => response.status).sort();
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(5);
    expect(await app.get(PrismaService).organization.count()).toBe(1);
    expect(await app.get(PrismaService).user.count()).toBe(1);
  });
});

describe('generated bootstrap token', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await startTestApp({ CHRONOS_BOOTSTRAP_TOKEN: undefined });
  });

  afterAll(async () => {
    await app.close();
  });

  it('is generated once and kept stable across restarts until used', async () => {
    const prisma = app.get(PrismaService);
    const first = await prisma.systemState.findUniqueOrThrow({ where: { id: 1 } });
    expect(first.bootstrapTokenHash).toMatch(/^[0-9a-f]{64}$/);

    await app.get(BootstrapService).ensureBootstrapToken();
    const second = await prisma.systemState.findUniqueOrThrow({ where: { id: 1 } });
    expect(second.bootstrapTokenHash).toBe(first.bootstrapTokenHash);
  });
});
