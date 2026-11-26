import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Chronos } from '@chronos/sdk';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { SchedulerHost } from '../src/infrastructure/engine/scheduler-host';
import { BootstrapService } from '../src/modules/bootstrap/bootstrap.service';
import { ADMIN, BootstrapResult, api, bearer, bootstrapInstallation, resetState, startTestApp } from './setup/test-app';
import { waitFor } from './setup/wait';

interface StreamEvent {
  event: string;
  data: Record<string, unknown>;
}

/** Minimal fetch-based SSE client, as a browser dashboard would use (EventSource cannot send headers). */
async function openStream(url: string, token: string) {
  const controller = new AbortController();
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
  const events: StreamEvent[] = [];
  let ended = false;
  if (response.ok && response.body) {
    void (async () => {
      const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let index: number;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const event = /^event: (.+)$/m.exec(block)?.[1];
            const data = /^data: (.+)$/m.exec(block)?.[1];
            if (event && data) events.push({ event, data: JSON.parse(data) as Record<string, unknown> });
          }
        }
      } catch {
        // aborted
      }
      ended = true;
    })();
  }
  return {
    response,
    events,
    get ended() {
      return ended;
    },
    next: (predicate: (event: StreamEvent) => boolean, timeoutMs = 10_000) =>
      waitFor(() => events.find(predicate), { timeoutMs, message: 'stream event' }),
    close: () => controller.abort(),
  };
}

describe('dashboard support API', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let server: string;
  let boot: BootstrapResult;
  let token: string;
  let base: string;
  const agents: Chronos[] = [];
  const streams: { close: () => void }[] = [];

  beforeAll(async () => {
    app = await startTestApp({
      CHRONOS_AGENT_HEARTBEAT_MS: '1000',
      CHRONOS_LEASE_MS: '5000',
      CHRONOS_CREDENTIAL_RECHECK_MS: '1000',
      CHRONOS_EVENTS_POLL_MS: '250',
    });
    await app.listen(0, '127.0.0.1');
    server = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await resetState(app);
    await app.get(BootstrapService).ensureBootstrapToken();
    boot = await bootstrapInstallation(app);
    token = boot.credentials.userToken.token;
    base = `/v1/projects/${boot.project.id}`;
  });

  afterEach(async () => {
    for (const stream of streams.splice(0)) stream.close();
    await Promise.all(agents.splice(0).map((agent) => agent.stop({ timeoutMs: 1000 })));
  });

  afterAll(async () => {
    await app.close();
  });

  function agent(): Chronos {
    const chronos = new Chronos({
      server,
      project: 'storefront',
      token: boot.credentials.agentToken.token,
      logger: false,
      reconnect: { initialDelayMs: 50, maxDelayMs: 200 },
    });
    chronos.on('error', () => undefined);
    agents.push(chronos);
    return chronos;
  }

  async function createJob(body: Record<string, unknown>) {
    const response = await api(app).post(`${base}/jobs`).set(...bearer(token)).send(body).expect(201);
    return response.body.data as { id: string; name: string };
  }

  async function trigger(jobId: string) {
    const response = await api(app).post(`${base}/jobs/${jobId}/trigger`).set(...bearer(token)).send({}).expect(201);
    return response.body.data.execution.id as string;
  }

  async function addMember(role: string, email: string): Promise<string> {
    const password = 'member-password-123';
    await api(app).post(`/v1/organizations/${boot.organization.id}/members`).set(...bearer(token)).send({ email, role, name: email, password }).expect(201);
    const login = await api(app).post('/v1/auth/login').send({ email, password }).expect(200);
    return login.body.data.token as string;
  }

  describe('security', () => {
    it('disconnects a connected agent when its credential is revoked', async () => {
      const chronos = agent();
      chronos.task('noop', async () => undefined);
      await chronos.start();
      expect(chronos.status).toBe('connected');

      await api(app).delete(`${base}/credentials/${boot.credentials.agentToken.id}`).set(...bearer(token)).expect(200);
      // Re-checked on the next heartbeat after CHRONOS_CREDENTIAL_RECHECK_MS; close code 4001 is fatal for the SDK.
      await waitFor(() => chronos.status === 'stopped', { timeoutMs: 8000, message: 'agent disconnected after revocation' });
      await waitFor(async () => (await prisma.agent.findFirst({ where: { status: 'OFFLINE' } })) !== null, { message: 'agent marked offline' });
    });

    it('marks API responses as non-cacheable', async () => {
      const response = await api(app).get('/v1/auth/me').set(...bearer(token)).expect(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    });
  });

  describe('account', () => {
    it('updates the profile name', async () => {
      const response = await api(app).patch('/v1/auth/me').set(...bearer(token)).send({ name: 'Renamed' }).expect(200);
      expect(response.body.data.name).toBe('Renamed');
      await api(app).patch('/v1/auth/me').set(...bearer(token)).send({ name: '' }).expect(400);
    });

    it('changes the password, revokes other sessions and keeps the current one', async () => {
      const second = (await api(app).post('/v1/auth/login').send({ email: ADMIN.email, password: ADMIN.password }).expect(200)).body.data.token as string;

      const wrong = await api(app).post('/v1/auth/password').set(...bearer(second)).send({ currentPassword: 'nope', newPassword: 'a-new-long-password' }).expect(400);
      expect(wrong.body.error.message).toMatch(/incorrect/);
      await api(app).post('/v1/auth/password').set(...bearer(second)).send({ currentPassword: ADMIN.password, newPassword: 'short' }).expect(400);

      const changed = await api(app)
        .post('/v1/auth/password')
        .set(...bearer(second))
        .send({ currentPassword: ADMIN.password, newPassword: 'a-new-long-password' })
        .expect(200);
      expect(changed.body.data.revokedSessions).toBe(1);

      await api(app).get('/v1/auth/me').set(...bearer(second)).expect(200); // current session survives
      await api(app).get('/v1/auth/me').set(...bearer(token)).expect(401); // other session revoked
      await api(app).post('/v1/auth/login').send({ email: ADMIN.email, password: ADMIN.password }).expect(401);
      await api(app).post('/v1/auth/login').send({ email: ADMIN.email, password: 'a-new-long-password' }).expect(200);
    });

    it('exposes installation info to signed-in users only', async () => {
      const response = await api(app).get('/v1/system').set(...bearer(token)).expect(200);
      expect(response.body.data).toMatchObject({ apiVersion: '1', features: { eventStream: true } });
      expect(Number.isNaN(Date.parse(response.body.data.serverTime))).toBe(false);
      await api(app).get('/v1/system').expect(401);
      await api(app).get('/v1/system').set(...bearer(boot.credentials.projectKey.token)).expect(403);
    });
  });

  describe('activity log', () => {
    it('lists organization activity for admins with filters, actor names and cursor pagination', async () => {
      const job = await createJob({ name: 'audited', mode: 'WORKER' });
      await trigger(job.id);
      await api(app).post(`${base}/jobs/${job.id}/trigger`).set(...bearer(boot.credentials.projectKey.token)).send({}).expect(201);

      const all = await api(app).get(`/v1/organizations/${boot.organization.id}/audit-logs`).set(...bearer(token)).expect(200);
      const actions = all.body.data.items.map((item: { action: string }) => item.action);
      expect(actions).toEqual(expect.arrayContaining(['job.created', 'job.triggered']));

      const jobs = await api(app).get(`/v1/organizations/${boot.organization.id}/audit-logs?action=job.`).set(...bearer(token)).expect(200);
      expect(jobs.body.data.items.every((item: { action: string }) => item.action.startsWith('job.'))).toBe(true);
      const byUser = jobs.body.data.items.find((item: { action: string; actor: { type: string } }) => item.action === 'job.created');
      expect(byUser.actor).toMatchObject({ type: 'USER', name: 'Admin', email: ADMIN.email });
      const byKey = jobs.body.data.items.find((item: { actor: { type: string } }) => item.actor.type === 'CREDENTIAL');
      expect(byKey.actor).toMatchObject({ credentialKind: 'PROJECT' });

      const page1 = await api(app).get(`/v1/organizations/${boot.organization.id}/audit-logs?action=job.&limit=1`).set(...bearer(token)).expect(200);
      expect(page1.body.data.items).toHaveLength(1);
      const page2 = await api(app)
        .get(`/v1/organizations/${boot.organization.id}/audit-logs?action=job.&limit=1&cursor=${page1.body.data.nextCursor}`)
        .set(...bearer(token))
        .expect(200);
      expect(page2.body.data.items[0].id).not.toBe(page1.body.data.items[0].id);
      expect(Number(page2.body.data.items[0].id)).toBeLessThan(Number(page1.body.data.items[0].id));
    });

    it('is restricted to admins of the organization', async () => {
      const member = await addMember('MEMBER', 'member@example.com');
      await api(app).get(`/v1/organizations/${boot.organization.id}/audit-logs`).set(...bearer(member)).expect(403);
      await api(app).get(`/v1/organizations/${boot.organization.id}/audit-logs`).set(...bearer(boot.credentials.projectKey.token)).expect(403);
      const other = await api(app).post('/v1/organizations').set(...bearer(member)).send({ name: 'Other', slug: 'other' }).expect(201);
      // The owner of acme is not a member of "other": not found, not forbidden.
      await api(app).get(`/v1/organizations/${other.body.data.id}/audit-logs`).set(...bearer(token)).expect(404);
      await api(app).get(`/v1/organizations/${boot.organization.id}/audit-logs?cursor=abc`).set(...bearer(token)).expect(400);
    });
  });

  describe('executions, logs and statistics', () => {
    it('filters executions by time range, trigger and mode', async () => {
      const job = await createJob({ name: 'filtered', mode: 'WORKER' });
      await trigger(job.id);
      await trigger(job.id);
      const list = (query: string) => api(app).get(`${base}/executions?${query}`).set(...bearer(token)).expect(200);

      expect((await list('trigger=MANUAL')).body.data.items).toHaveLength(2);
      expect((await list('trigger=SCHEDULE')).body.data.items).toHaveLength(0);
      expect((await list('mode=WORKER')).body.data.items).toHaveLength(2);
      expect((await list('mode=HTTP')).body.data.items).toHaveLength(0);
      const future = new Date(Date.now() + 3600_000).toISOString();
      const past = new Date(Date.now() - 3600_000).toISOString();
      expect((await list(`from=${future}`)).body.data.items).toHaveLength(0);
      expect((await list(`from=${past}&to=${future}`)).body.data.items).toHaveLength(2);
      await api(app).get(`${base}/executions?from=${future}&to=${past}`).set(...bearer(token)).expect(400);
    });

    it('pages through execution logs for live tailing', async () => {
      const job = await createJob({ name: 'chatty', mode: 'WORKER' });
      const executionId = await trigger(job.id);
      await prisma.executionLog.createMany({ data: Array.from({ length: 5 }, (_, i) => ({ executionId, level: 'INFO' as const, message: `line ${i}` })) });

      const first = await api(app).get(`${base}/executions/${executionId}/logs?limit=3`).set(...bearer(token)).expect(200);
      expect(first.body.data.items.map((log: { message: string }) => log.message)).toEqual(['line 0', 'line 1', 'line 2']);
      const second = await api(app).get(`${base}/executions/${executionId}/logs?afterId=${first.body.data.nextAfterId}`).set(...bearer(token)).expect(200);
      expect(second.body.data.items.map((log: { message: string }) => log.message)).toEqual(['line 3', 'line 4']);
      const empty = await api(app).get(`${base}/executions/${executionId}/logs?afterId=${second.body.data.nextAfterId}`).set(...bearer(token)).expect(200);
      expect(empty.body.data).toEqual({ items: [], nextAfterId: second.body.data.nextAfterId });

      const detail = await api(app).get(`${base}/executions/${executionId}`).set(...bearer(token)).expect(200);
      expect(detail.body.data.logsTruncated).toBe(false);
      await api(app).get(`${base}/executions/00000000-0000-4000-8000-000000000000/logs`).set(...bearer(token)).expect(404);
    });

    it('reports per-job stats and a gap-filled time series', async () => {
      const a = await createJob({ name: 'stats-a', mode: 'WORKER' });
      const b = await createJob({ name: 'stats-b', mode: 'WORKER' });
      await trigger(a.id);
      await trigger(a.id);
      await trigger(b.id);

      const all = await api(app).get(`${base}/stats`).set(...bearer(token)).expect(200);
      expect(all.body.data).toMatchObject({ jobs: 2, jobsEnabled: 2, jobsPaused: 0, executions: { PENDING: 3 }, durationMs: { p50: null, p95: null } });
      const one = await api(app).get(`${base}/stats?jobId=${a.id}`).set(...bearer(token)).expect(200);
      expect(one.body.data.executions).toEqual({ PENDING: 2 });

      const series = await api(app).get(`${base}/stats/timeseries?hours=24`).set(...bearer(token)).expect(200);
      const points = series.body.data.points as { at: string; counts: Record<string, number> }[];
      expect(points.length).toBeGreaterThanOrEqual(24);
      expect(points.reduce((sum, point) => sum + (point.counts.PENDING ?? 0), 0)).toBe(3);
      const times = points.map((point) => Date.parse(point.at));
      expect([...times].sort((x, y) => x - y)).toEqual(times);
      expect(times[1]! - times[0]!).toBe(3600_000);
    });
  });

  describe('dashboard analytics', () => {
    it('breaks stats and time series down by mode and kind, filterable by queue', async () => {
      await api(app).post(`${base}/queues`).set(...bearer(token)).send({ name: 'mail' }).expect(201);
      const worker = await createJob({ name: 'w-job', mode: 'WORKER', queue: 'mail' });
      await createJob({ name: 'a-job', mode: 'AGENT' });
      await trigger(worker.id);
      await api(app).post(`${base}/queue`).set(...bearer(token)).send({ job: 'a-job' }).expect(201);
      await api(app).post(`${base}/queue`).set(...bearer(token)).send({ job: 'a-job', delayMs: 600_000 }).expect(201);

      const all = (await api(app).get(`${base}/stats`).set(...bearer(token)).expect(200)).body.data;
      expect(all.byMode).toEqual({ WORKER: 1, AGENT: 2 });
      expect(all.byKind).toEqual({ scheduled: 0, manual: 1, immediate: 1, delayed: 1 });
      const mail = (await api(app).get(`${base}/stats?queue=mail`).set(...bearer(token)).expect(200)).body.data;
      expect(mail).toMatchObject({ queue: 'mail', executions: { PENDING: 1 }, byMode: { WORKER: 1 } });

      const series = (await api(app).get(`${base}/stats/timeseries?hours=2&mode=AGENT`).set(...bearer(token)).expect(200)).body.data;
      const totals = series.points.reduce((sum: { delayed: number; immediate: number }, point: { byKind: { delayed: number; immediate: number } }) => ({ delayed: sum.delayed + point.byKind.delayed, immediate: sum.immediate + point.byKind.immediate }), { delayed: 0, immediate: 0 });
      expect(totals).toEqual({ delayed: 1, immediate: 1 });
      expect(series.points[0]).toHaveProperty('durationMs');
      await api(app).get(`${base}/stats?queue=Not_Valid!`).set(...bearer(token)).expect(400);
    });

    it('lists jobs with their most recent execution', async () => {
      const job = await createJob({ name: 'with-history', mode: 'WORKER' });
      await createJob({ name: 'never-ran', mode: 'WORKER' });
      await trigger(job.id);
      const latest = await trigger(job.id);
      const jobs = (await api(app).get(`${base}/jobs`).set(...bearer(token)).expect(200)).body.data as { name: string; lastExecution: { id: string; status: string } | null }[];
      expect(jobs.find((item) => item.name === 'with-history')?.lastExecution).toMatchObject({ id: latest, status: 'PENDING' });
      expect(jobs.find((item) => item.name === 'never-ran')?.lastExecution).toBeNull();
    });

    it('filters executions by worker and shows worker detail without leaking other tenants', async () => {
      const job = await createJob({ name: 'by-worker', mode: 'WORKER' });
      const mine = await trigger(job.id);
      await trigger(job.id);
      const workerRow = await prisma.worker.create({ data: { instanceId: 'w-1', version: 'test', concurrency: 2 } });
      await prisma.jobAttempt.create({ data: { executionId: mine, attemptNumber: 1, status: 'SUCCEEDED', workerId: workerRow.id, finishedAt: new Date() } });

      // Another organization's execution on the same worker.
      const other = await api(app).post('/v1/organizations').set(...bearer(token)).send({ name: 'Other', slug: 'other-org' }).expect(201);
      const otherProject = await api(app).post(`/v1/organizations/${other.body.data.id}/projects`).set(...bearer(token)).send({ name: 'Secret', slug: 'secret' }).expect(201);
      const secretJob = await api(app).post(`/v1/projects/${otherProject.body.data.id}/jobs`).set(...bearer(token)).send({ name: 'secret-job', mode: 'WORKER' }).expect(201);
      const secretExec = await api(app).post(`/v1/projects/${otherProject.body.data.id}/jobs/${secretJob.body.data.id}/trigger`).set(...bearer(token)).send({}).expect(201);
      await prisma.jobAttempt.create({ data: { executionId: secretExec.body.data.execution.id, attemptNumber: 1, status: 'FAILED', workerId: workerRow.id, finishedAt: new Date() } });
      const member = await addMember('VIEWER', 'viewer@example.com');

      const filtered = (await api(app).get(`${base}/executions?workerId=${workerRow.id}`).set(...bearer(token)).expect(200)).body.data.items;
      expect(filtered.map((item: { id: string }) => item.id)).toEqual([mine]);
      expect(filtered[0].executor).toEqual({ kind: 'WORKER', id: workerRow.id, name: 'w-1' });

      const asViewer = (await api(app).get(`/v1/workers/${workerRow.id}`).set(...bearer(member)).expect(200)).body.data;
      expect(asViewer.attempts24h).toMatchObject({ succeeded: 1, failed: 1 });
      expect(asViewer.recentAttempts.map((attempt: { jobName: string }) => attempt.jobName)).toEqual(['by-worker']);
      const listed = (await api(app).get('/v1/workers').set(...bearer(token)).expect(200)).body.data;
      expect(listed[0]).toMatchObject({ id: workerRow.id, runningExecutions: 0 });
      await api(app).get('/v1/workers/00000000-0000-4000-8000-000000000000').set(...bearer(token)).expect(404);
    });
  });

  describe('jobs and schedules', () => {
    it('keeps stored webhook secrets when a masked config is sent back on edit', async () => {
      const job = await createJob({
        name: 'hook',
        mode: 'HTTP',
        http: { url: 'https://example.com/a', headers: { 'X-Api-Key': 'real-key' }, auth: { type: 'bearer', token: 'real-token' }, signingSecret: 'a-real-signing-secret' },
      });
      const shown = (await api(app).get(`${base}/jobs/${job.id}`).set(...bearer(token)).expect(200)).body.data;
      expect(shown.http).toMatchObject({ headers: { 'X-Api-Key': '********' }, auth: { token: '********' }, signingSecret: '********' });

      // A dashboard edit form sends the masked object back with only the URL changed.
      await api(app).patch(`${base}/jobs/${job.id}`).set(...bearer(token)).send({ http: { ...shown.http, url: 'https://example.com/b' } }).expect(200);
      const stored = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
      expect(stored.httpConfig).toMatchObject({
        url: 'https://example.com/b',
        headers: { 'X-Api-Key': 'real-key' },
        auth: { type: 'bearer', token: 'real-token' },
        signingSecret: 'a-real-signing-secret',
      });

      const rejected = await api(app)
        .post(`${base}/jobs`)
        .set(...bearer(token))
        .send({ name: 'hook-2', mode: 'HTTP', http: { url: 'https://example.com', auth: { type: 'bearer', token: '********' } } })
        .expect(400);
      expect(rejected.body.error.message).toMatch(/masked/);
    });

    it('searches jobs by name and filters by source', async () => {
      await createJob({ name: 'nightly-sync', mode: 'WORKER', description: 'pulls invoices' });
      await createJob({ name: 'cleanup', mode: 'WORKER' });
      const byName = await api(app).get(`${base}/jobs?q=SYNC`).set(...bearer(token)).expect(200);
      expect(byName.body.data.map((job: { name: string }) => job.name)).toEqual(['nightly-sync']);
      const byDescription = await api(app).get(`${base}/jobs?q=invoice`).set(...bearer(token)).expect(200);
      expect(byDescription.body.data).toHaveLength(1);
      const sdk = await api(app).get(`${base}/jobs?source=SDK`).set(...bearer(token)).expect(200);
      expect(sdk.body.data).toHaveLength(0);
    });

    it('previews an unsaved schedule and rejects invalid ones', async () => {
      const preview = await api(app)
        .post(`${base}/schedule/preview`)
        .set(...bearer(token))
        .send({ schedule: { cron: '*/15 * * * *', timezone: 'UTC' }, count: 3 })
        .expect(200);
      const times = (preview.body.data.occurrences as string[]).map((value) => Date.parse(value));
      expect(times).toHaveLength(3);
      expect(times[1]! - times[0]!).toBe(15 * 60_000);

      const projectZone = await api(app).post(`${base}/schedule/preview`).set(...bearer(token)).send({ schedule: { cron: '0 2 * * *' } }).expect(200);
      expect(projectZone.body.data.timezone).toBe('Asia/Dhaka');

      const invalid = await api(app).post(`${base}/schedule/preview`).set(...bearer(token)).send({ schedule: { cron: '61 * * * *' } }).expect(400);
      expect(invalid.body.error.code).toBe('VALIDATION_FAILED');
      await api(app).post(`${base}/schedule/preview`).set(...bearer(token)).send({ schedule: { cron: '* * * * *', timezone: 'Mars/Base' } }).expect(400);
    });

    it('projects upcoming occurrences of active schedules into a calendar range', async () => {
      await createJob({ name: 'hourly', mode: 'WORKER', schedule: { cron: '0 * * * *', timezone: 'UTC' } });
      await createJob({ name: 'six-hourly', mode: 'WORKER', schedule: { cron: '30 */6 * * *', timezone: 'UTC' } });
      const paused = await createJob({ name: 'paused', mode: 'WORKER', schedule: { cron: '* * * * *', timezone: 'UTC' } });
      await api(app).post(`${base}/jobs/${paused.id}/pause`).set(...bearer(token)).expect(200);
      await createJob({ name: 'disabled', mode: 'WORKER', enabled: false, schedule: { cron: '* * * * *', timezone: 'UTC' } });

      const to = new Date(Date.now() + 24 * 3600_000).toISOString();
      const response = await api(app).get(`${base}/schedule/upcoming?to=${to}`).set(...bearer(token)).expect(200);
      const occurrences = response.body.data.occurrences as { at: string; jobName: string }[];
      const count = (name: string) => occurrences.filter((occurrence) => occurrence.jobName === name).length;
      expect(count('hourly')).toBeGreaterThanOrEqual(23);
      expect(count('hourly')).toBeLessThanOrEqual(24);
      expect(count('six-hourly')).toBe(4);
      expect(count('paused') + count('disabled')).toBe(0);
      const times = occurrences.map((occurrence) => Date.parse(occurrence.at));
      expect([...times].sort((x, y) => x - y)).toEqual(times);
      expect(response.body.data.truncated).toBe(false);

      const far = new Date(Date.now() + 200 * 86_400_000).toISOString();
      await api(app).get(`${base}/schedule/upcoming?to=${far}`).set(...bearer(token)).expect(400);
      await api(app).get(`${base}/schedule/upcoming?to=${new Date(Date.now() - 1000).toISOString()}`).set(...bearer(token)).expect(400);
    });
  });

  describe('agents', () => {
    it('shows agent details and removes only offline agents', async () => {
      const chronos = agent();
      chronos.task('noop', async () => undefined);
      await chronos.start();
      const [listed] = (await api(app).get(`${base}/agents`).set(...bearer(token)).expect(200)).body.data as { id: string }[];
      const detail = await api(app).get(`${base}/agents/${listed!.id}`).set(...bearer(token)).expect(200);
      expect(detail.body.data).toMatchObject({ status: 'ONLINE', runningExecutions: 0, credentialId: boot.credentials.agentToken.id });
      expect(JSON.stringify(detail.body.data)).not.toContain('chr_a_');

      await api(app).delete(`${base}/agents/${listed!.id}`).set(...bearer(token)).expect(409);
      await chronos.stop();
      await waitFor(async () => (await prisma.agent.findUnique({ where: { id: listed!.id } }))?.status === 'OFFLINE', { message: 'agent offline' });
      await api(app).delete(`${base}/agents/${listed!.id}`).set(...bearer(boot.credentials.projectKey.token)).expect(403);
      await api(app).delete(`${base}/agents/${listed!.id}`).set(...bearer(token)).expect(204);
      await api(app).get(`${base}/agents/${listed!.id}`).set(...bearer(token)).expect(404);
    });
  });

  describe('real-time event stream', () => {
    it('requires authentication and project access', async () => {
      const anonymous = await fetch(`${server}${base}/events`);
      expect(anonymous.status).toBe(401);
      await anonymous.body?.cancel();
      const other = await api(app).post('/v1/organizations').set(...bearer(token)).send({ name: 'Other', slug: 'other' }).expect(201);
      const otherProject = await api(app).post(`/v1/organizations/${other.body.data.id}/projects`).set(...bearer(token)).send({ name: 'Other project', slug: 'other-project' }).expect(201);
      const foreign = await fetch(`${server}/v1/projects/${otherProject.body.data.id}/events`, {
        headers: { Authorization: `Bearer ${boot.credentials.projectKey.token}` },
      });
      expect(foreign.status).toBe(404);
      await foreign.body?.cancel();
    });

    it('streams execution and agent changes, then closes when the session is revoked', async () => {
      const job = await createJob({ name: 'streamed', mode: 'AGENT' });
      const stream = await openStream(`${server}${base}/events`, token);
      streams.push(stream);
      expect(stream.response.status).toBe(200);
      expect(stream.response.headers.get('content-type')).toMatch(/^text\/event-stream/);
      await stream.next((event) => event.event === 'ready');

      const executionId = await trigger(job.id);
      await stream.next((event) => event.event === 'execution.updated' && event.data.id === executionId && event.data.status === 'PENDING');
      await app.get(SchedulerHost).runtime.cycle();
      const queued = await stream.next((event) => event.event === 'execution.updated' && event.data.id === executionId && event.data.status === 'QUEUED');
      expect(queued.data).toMatchObject({ jobName: 'streamed', trigger: 'MANUAL', mode: 'AGENT' });

      const chronos = agent();
      chronos.task('streamed', async () => ({ ok: true }));
      await chronos.start();
      await stream.next((event) => event.event === 'agent.updated' && event.data.status === 'ONLINE');
      await stream.next((event) => event.event === 'execution.updated' && event.data.id === executionId && event.data.status === 'SUCCEEDED');

      // Each state is delivered once even though lease renewals keep touching the row.
      const pending = stream.events.filter((event) => event.event === 'execution.updated' && event.data.status === 'PENDING');
      expect(pending).toHaveLength(1);

      await api(app).post('/v1/auth/logout').set(...bearer(token)).expect(204);
      const closed = await stream.next((event) => event.event === 'close', 8000);
      expect(closed.data).toEqual({ reason: 'unauthorized' });
      await waitFor(() => stream.ended, { message: 'stream ended' });
    });
  });
});
