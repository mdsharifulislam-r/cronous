import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { BootstrapService } from '../src/modules/bootstrap/bootstrap.service';
import { ADMIN, BootstrapResult, api, bearer, bootstrapInstallation, resetState, startTestApp } from './setup/test-app';

const MAX_FAILURES = 3;

async function login(app: NestExpressApplication, email: string, password: string): Promise<string> {
  const response = await api(app).post('/v1/auth/login').send({ email, password }).expect(200);
  return response.body.data.token as string;
}

describe('authentication, organizations, projects and credentials', () => {
  let app: NestExpressApplication;
  let boot: BootstrapResult;
  let ownerToken: string;

  beforeAll(async () => {
    app = await startTestApp({ CHRONOS_LOGIN_MAX_FAILURES: String(MAX_FAILURES) });
  });

  beforeEach(async () => {
    await resetState(app);
    await app.get(BootstrapService).ensureBootstrapToken();
    boot = await bootstrapInstallation(app);
    ownerToken = boot.credentials.userToken.token;
  });

  afterAll(async () => {
    await app?.close();
  });

  async function addMember(role: string, email: string) {
    const password = 'member-password-123';
    await api(app)
      .post(`/v1/organizations/${boot.organization.id}/members`)
      .set(...bearer(ownerToken))
      .send({ email, role, name: email, password })
      .expect(201);
    return login(app, email, password);
  }

  describe('login', () => {
    it('issues a session token and revokes it on logout', async () => {
      const token = await login(app, ADMIN.email, ADMIN.password);
      expect(token).toMatch(/^chr_u_/);
      await api(app).get('/v1/auth/me').set(...bearer(token)).expect(200);
      await api(app).post('/v1/auth/logout').set(...bearer(token)).expect(204);
      await api(app).get('/v1/auth/me').set(...bearer(token)).expect(401);
    });

    it('uses one message for unknown users and wrong passwords', async () => {
      const unknown = await api(app).post('/v1/auth/login').send({ email: 'nobody@example.com', password: 'x' }).expect(401);
      const wrong = await api(app).post('/v1/auth/login').send({ email: ADMIN.email, password: 'wrong' }).expect(401);
      expect(unknown.body.error.message).toBe(wrong.body.error.message);
    });

    it('locks out after repeated failures, even for the correct password', async () => {
      for (let i = 0; i < MAX_FAILURES; i += 1) {
        await api(app).post('/v1/auth/login').send({ email: ADMIN.email, password: 'wrong' }).expect(401);
      }
      const locked = await api(app).post('/v1/auth/login').send({ email: ADMIN.email, password: ADMIN.password }).expect(429);
      expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('rejects malformed and unknown bearer tokens', async () => {
      await api(app).get('/v1/auth/me').set('Authorization', 'Basic abc').expect(401);
      await api(app).get('/v1/auth/me').set(...bearer('chr_u_not-a-real-token')).expect(401);
      await api(app).get('/v1/auth/me').expect(401);
    });
  });

  describe('organizations and RBAC', () => {
    it('lets any user create an organization and become its owner', async () => {
      const created = await api(app)
        .post('/v1/organizations')
        .set(...bearer(ownerToken))
        .send({ name: 'Second', slug: 'second' })
        .expect(201);
      expect(created.body.data.role).toBe('OWNER');
      await api(app).post('/v1/organizations').set(...bearer(ownerToken)).send({ name: 'Dup', slug: 'second' }).expect(409);
      const list = await api(app).get('/v1/organizations').set(...bearer(ownerToken)).expect(200);
      expect(list.body.data.map((org: { slug: string }) => org.slug).sort()).toEqual(['acme', 'second']);
    });

    it('enforces role hierarchy on projects', async () => {
      const viewer = await addMember('VIEWER', 'viewer@example.com');
      const admin = await addMember('ADMIN', 'admin2@example.com');
      const projectsPath = `/v1/organizations/${boot.organization.id}/projects`;

      await api(app).get(projectsPath).set(...bearer(viewer)).expect(200);
      await api(app).post(projectsPath).set(...bearer(viewer)).send({ name: 'P', slug: 'p-one' }).expect(403);
      const created = await api(app).post(projectsPath).set(...bearer(admin)).send({ name: 'P', slug: 'p-one' }).expect(201);
      expect(created.body.data.timezone).toBe('UTC');
      await api(app).post(projectsPath).set(...bearer(admin)).send({ name: 'P', slug: 'p-one' }).expect(409);
      await api(app).get(`/v1/projects/${boot.project.id}/credentials`).set(...bearer(viewer)).expect(403);
    });

    it('hides organizations from non-members with 404', async () => {
      const other = await api(app).post('/v1/organizations').set(...bearer(ownerToken)).send({ name: 'Other', slug: 'other' });
      const outsider = await addMember('VIEWER', 'outsider@example.com');
      // outsider is a member of acme only
      await api(app).get(`/v1/organizations/${other.body.data.id}`).set(...bearer(outsider)).expect(404);
      await api(app).get('/v1/organizations/not-a-uuid').set(...bearer(outsider)).expect(404);
    });

    it('prevents admins from granting OWNER and protects the last owner', async () => {
      const admin = await addMember('ADMIN', 'admin3@example.com');
      const members = `/v1/organizations/${boot.organization.id}/members`;
      await api(app)
        .post(members)
        .set(...bearer(admin))
        .send({ email: 'x@example.com', role: 'OWNER', name: 'X', password: 'some-long-password' })
        .expect(403);
      await api(app).patch(`${members}/${boot.user.id}`).set(...bearer(admin)).send({ role: 'MEMBER' }).expect(403);

      const demote = await api(app).patch(`${members}/${boot.user.id}`).set(...bearer(ownerToken)).send({ role: 'ADMIN' }).expect(409);
      expect(demote.body.error.message).toMatch(/at least one owner/);
      await api(app).delete(`${members}/${boot.user.id}`).set(...bearer(ownerToken)).expect(409);
    });

    it('never lets an admin reset an existing user password via add-member', async () => {
      await api(app).post('/v1/organizations').set(...bearer(ownerToken)).send({ name: 'B', slug: 'org-b' });
      const response = await api(app)
        .post(`/v1/organizations/${boot.organization.id}/members`)
        .set(...bearer(ownerToken))
        .send({ email: ADMIN.email, role: 'MEMBER', name: 'Hijack', password: 'attacker-password-1' })
        .expect(409);
      expect(response.body.error.code).toBe('CONFLICT');
      await login(app, ADMIN.email, ADMIN.password);
    });

    it('serialises concurrent owner demotions so one owner always remains', async () => {
      const members = `/v1/organizations/${boot.organization.id}/members`;
      const second = await addMember('OWNER', 'owner2@example.com');
      const me = await api(app).get('/v1/auth/me').set(...bearer(second)).expect(200);
      const results = await Promise.all([
        api(app).patch(`${members}/${boot.user.id}`).set(...bearer(second)).send({ role: 'ADMIN' }),
        api(app).patch(`${members}/${me.body.data.id}`).set(...bearer(ownerToken)).send({ role: 'ADMIN' }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const owners = await app.get(PrismaService).membership.count({ where: { organizationId: boot.organization.id, role: 'OWNER' } });
      expect(owners).toBe(1);
    });
  });

  describe('project credentials', () => {
    const credentialsPath = () => `/v1/projects/${boot.project.id}/credentials`;

    it('creates, lists without secrets, and revokes', async () => {
      const created = await api(app)
        .post(credentialsPath())
        .set(...bearer(ownerToken))
        .send({ kind: 'AGENT', name: 'api server' })
        .expect(201);
      expect(created.body.data.token).toMatch(/^chr_a_/);

      const list = await api(app).get(credentialsPath()).set(...bearer(ownerToken)).expect(200);
      expect(list.body.data).toHaveLength(3);
      expect(JSON.stringify(list.body.data)).not.toContain(created.body.data.token);
      expect(list.body.data.every((c: Record<string, unknown>) => !('tokenHash' in c) && !('token' in c))).toBe(true);

      await api(app).delete(`${credentialsPath()}/${created.body.data.id}`).set(...bearer(ownerToken)).expect(200);
      const active = await api(app).get(credentialsPath()).set(...bearer(ownerToken)).expect(200);
      expect(active.body.data).toHaveLength(2);
    });

    it('rotates with a grace period and only once', async () => {
      const oldKey = boot.credentials.projectKey;
      const rotated = await api(app)
        .post(`${credentialsPath()}/${oldKey.id}/rotate`)
        .set(...bearer(ownerToken))
        .send({ gracePeriodSeconds: 600 })
        .expect(201);
      const newToken = rotated.body.data.credential.token as string;
      expect(rotated.body.data.credential.rotatedFromId).toBe(oldKey.id);

      // Both work during the grace period.
      await api(app).get(`/v1/projects/${boot.project.id}`).set(...bearer(oldKey.token)).expect(200);
      await api(app).get(`/v1/projects/${boot.project.id}`).set(...bearer(newToken)).expect(200);

      await api(app).post(`${credentialsPath()}/${oldKey.id}/rotate`).set(...bearer(ownerToken)).send({}).expect(409);
    });

    it('revokes immediately when rotating with no grace period', async () => {
      const oldKey = boot.credentials.projectKey;
      await api(app)
        .post(`${credentialsPath()}/${oldKey.id}/rotate`)
        .set(...bearer(ownerToken))
        .send({ gracePeriodSeconds: 0 })
        .expect(201);
      await api(app).get(`/v1/projects/${boot.project.id}`).set(...bearer(oldKey.token)).expect(401);
    });

    it('confines project keys to their own project and below admin', async () => {
      const key = boot.credentials.projectKey.token;
      const other = await api(app)
        .post(`/v1/organizations/${boot.organization.id}/projects`)
        .set(...bearer(ownerToken))
        .send({ name: 'Other', slug: 'other-project' })
        .expect(201);
      await api(app).get(`/v1/projects/${other.body.data.id}`).set(...bearer(key)).expect(404);
      await api(app).get(credentialsPath()).set(...bearer(key)).expect(403);
    });

    it('revokes all project credentials when the project is archived', async () => {
      await api(app).delete(`/v1/projects/${boot.project.id}`).set(...bearer(ownerToken)).expect(204);
      await api(app).get(`/v1/projects/${boot.project.id}`).set(...bearer(boot.credentials.projectKey.token)).expect(401);
      await api(app).get(`/v1/projects/${boot.project.id}`).set(...bearer(ownerToken)).expect(404);
      const audit = await app.get(PrismaService).auditLog.findFirst({ where: { action: 'project.archived' } });
      expect(audit?.metadata).toEqual({ revokedCredentials: 2 });
    });
  });
});
