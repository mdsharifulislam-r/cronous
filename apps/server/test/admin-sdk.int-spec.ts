import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Chronos,
  ChronosAdmin,
  ChronosAuthError,
  ChronosConfigError,
  ChronosConflictError,
  ChronosNotFoundError,
  ChronosValidationError,
  ChronosWaitTimeoutError,
  NonRetryableError,
} from '@sharifulislam1/cronous';
import { SchedulerHost } from '../src/infrastructure/engine/scheduler-host';
import { BootstrapService } from '../src/modules/bootstrap/bootstrap.service';
import { BootstrapResult, api, bearer, bootstrapInstallation, resetState, startTestApp } from './setup/test-app';

describe('SDK admin client (ChronosAdmin) against a real server', () => {
  let app: NestExpressApplication;
  let server: string;
  let boot: BootstrapResult;
  let ticker: NodeJS.Timeout | undefined;
  let inFlight: Promise<unknown> = Promise.resolve();
  const agents: Chronos[] = [];

  beforeAll(async () => {
    app = await startTestApp({ CHRONOS_AGENT_HEARTBEAT_MS: '1000', CHRONOS_LEASE_MS: '5000' });
    await app.listen(0, '127.0.0.1');
    server = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  beforeEach(async () => {
    await resetState(app);
    await app.get(BootstrapService).ensureBootstrapToken();
    boot = await bootstrapInstallation(app);
  });

  afterEach(async () => {
    if (ticker) clearInterval(ticker);
    ticker = undefined;
    await inFlight; // a cycle still running must not touch the next test's data
    await Promise.all(agents.splice(0).map((agent) => agent.stop({ timeoutMs: 1000 })));
  });

  afterAll(async () => {
    await app.close();
  });

  const admin = (token = boot.credentials.projectKey.token, project = 'storefront') => new ChronosAdmin({ server, project, token, maxAttempts: 2 });

  /** Runs scheduler cycles in the background (admission, delayed runs, retries). */
  function runScheduler() {
    let busy = false;
    ticker = setInterval(() => {
      if (busy) return;
      busy = true;
      inFlight = app.get(SchedulerHost).runtime.cycle().catch(() => undefined).finally(() => (busy = false));
    }, 100);
  }

  async function startAgent(register: (chronos: Chronos) => void) {
    const chronos = new Chronos({ server, project: 'storefront', token: boot.credentials.agentToken.token, logger: false, reconnect: { initialDelayMs: 50, maxDelayMs: 200 } });
    chronos.on('error', () => undefined);
    register(chronos);
    await chronos.start();
    agents.push(chronos);
    return chronos;
  }

  it('identifies the project of project keys and agent tokens, not user sessions', async () => {
    const key = await api(app).get('/v1/identity').set(...bearer(boot.credentials.projectKey.token)).expect(200);
    expect(key.body.data).toMatchObject({ kind: 'PROJECT', projectId: boot.project.id, projectSlug: 'storefront', organizationId: boot.organization.id, credentialId: boot.credentials.projectKey.id });
    const agent = await api(app).get('/v1/identity').set(...bearer(boot.credentials.agentToken.token)).expect(200);
    expect(agent.body.data).toMatchObject({ kind: 'AGENT', projectId: boot.project.id });
    await api(app).get('/v1/identity').set(...bearer(boot.credentials.userToken.token)).expect(403);
    await api(app).get('/v1/identity').expect(401);
  });

  it('resolves the project from a project key or a user token and rejects a wrong slug', async () => {
    expect(await admin().project()).toMatchObject({ id: boot.project.id, slug: 'storefront' });
    expect(await admin(boot.credentials.userToken.token).project()).toMatchObject({ id: boot.project.id });
    await expect(admin(boot.credentials.projectKey.token, 'other').jobs.list()).rejects.toBeInstanceOf(ChronosConfigError);
    await expect(admin(boot.credentials.userToken.token, 'other').jobs.list()).rejects.toBeInstanceOf(ChronosNotFoundError);
    await expect(admin('chr_p_invalid').jobs.list()).rejects.toBeInstanceOf(ChronosAuthError);
    expect(() => new ChronosAdmin({ server, project: '' })).toThrow(ChronosConfigError);
  });

  it('manages jobs by name: create, read, update, schedule control, delete', async () => {
    const client = admin();
    const created = await client.jobs.create({ name: 'nightly-report', mode: 'AGENT', description: 'v1', schedule: { cron: '0 2 * * *', timezone: 'UTC' } });
    expect(created).toMatchObject({ name: 'nightly-report', mode: 'AGENT', source: 'API', enabled: true, schedule: { type: 'CRON', state: 'ACTIVE' } });
    await expect(client.jobs.create({ name: 'nightly-report', mode: 'AGENT' })).rejects.toBeInstanceOf(ChronosConflictError);
    await expect(client.jobs.create({ name: 'bad', mode: 'HTTP' })).rejects.toBeInstanceOf(ChronosValidationError);

    expect((await client.jobs.get('nightly-report')).id).toBe(created.id);
    expect((await client.jobs.get(created.id)).name).toBe('nightly-report');
    expect((await client.jobs.list({ mode: 'AGENT' })).map((job) => job.name)).toEqual(['nightly-report']);
    expect(await client.jobs.list({ mode: 'HTTP' })).toEqual([]);

    expect((await client.jobs.update('nightly-report', { description: 'v2', maxAttempts: 5 })).description).toBe('v2');
    expect((await client.jobs.pause('nightly-report')).schedule?.state).toBe('PAUSED');
    expect((await client.jobs.resume('nightly-report')).schedule?.state).toBe('ACTIVE');
    const runs = await client.jobs.nextRuns('nightly-report', 3);
    expect(runs.occurrences).toHaveLength(3);
    expect(runs.occurrences.every((at) => at.endsWith('T02:00:00.000Z'))).toBe(true);
    expect((await client.jobs.disable('nightly-report')).enabled).toBe(false);
    await expect(client.jobs.trigger('nightly-report')).rejects.toBeInstanceOf(ChronosConflictError);
    expect((await client.jobs.enable('nightly-report')).enabled).toBe(true);

    await client.jobs.delete('nightly-report');
    await expect(client.jobs.get('nightly-report')).rejects.toBeInstanceOf(ChronosNotFoundError);
    await expect(client.jobs.get('00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(ChronosNotFoundError);

    // A job recreated under the same name gets a new id; the client's cached id is refreshed.
    await client.jobs.create({ name: 'nightly-report', mode: 'WORKER' });
    const other = admin();
    await other.jobs.get('nightly-report');
    await other.jobs.delete('nightly-report');
    const recreated = await client.jobs.create({ name: 'nightly-report', mode: 'WORKER' });
    expect((await other.jobs.get('nightly-report')).id).toBe(recreated.id);
  });

  it('triggers and queues work, waits for results, reads logs, retries and cancels', async () => {
    const client = admin();
    await client.jobs.create({ name: 'report', mode: 'AGENT', maxAttempts: 1 });
    let fail = true;
    await startAgent((chronos) =>
      chronos.task('report', async (ctx) => {
        ctx.log.info('building', { payload: ctx.payload });
        if (fail) throw new NonRetryableError('boom');
        return { rows: 3 };
      }),
    );
    runScheduler();

    const failed = await client.jobs.trigger('report', { payload: { day: 1 } });
    expect(failed).toMatchObject({ status: 'PENDING', trigger: 'MANUAL', created: true });
    expect(Object.keys(failed).sort()).toEqual(['created', 'id', 'idempotencyKey', 'jobId', 'scheduledFor', 'status', 'trigger']);
    const failedDone = await client.executions.wait(failed.id, { timeoutMs: 15_000, intervalMs: 100 });
    expect(failedDone).toMatchObject({ status: 'FAILED', payload: { day: 1 } });

    fail = false;
    expect(await client.executions.retry(failed.id)).toMatchObject({ id: failed.id, status: 'PENDING' });
    const retried = await client.executions.wait(failed.id, { timeoutMs: 15_000, intervalMs: 100 });
    expect(retried.status).toBe('SUCCEEDED');
    expect(retried.result).toEqual({ rows: 3 });
    const logs = await client.executions.logs(failed.id);
    expect(logs.items.map((line) => line.message)).toContain('building');

    const queued = await client.queue('report', { day: 2 });
    expect(queued).toMatchObject({ jobName: 'report', trigger: 'QUEUE', delayed: false, created: true });
    expect((await client.executions.wait(queued.id, { timeoutMs: 15_000, intervalMs: 100 })).status).toBe('SUCCEEDED');

    const later = await client.queue('report', { day: 3 }, { delay: 60_000 });
    expect(later.delayed).toBe(true);
    await expect(client.executions.wait(later.id, { timeoutMs: 300, intervalMs: 100 })).rejects.toBeInstanceOf(ChronosWaitTimeoutError);
    expect(await client.cancel(later.id)).toBe(true);
    expect(await client.cancel(later.id)).toBe(false);
    expect((await client.executions.get(later.id)).status).toBe('CANCELLED');

    const page = await client.executions.list({ job: 'report', status: ['SUCCEEDED', 'CANCELLED'], limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    const all = [];
    for await (const execution of client.executions.iterate({ job: 'report', limit: 1 })) all.push(execution.id);
    expect(new Set(all)).toEqual(new Set([failed.id, queued.id, later.id]));

    const stats = await client.stats.summary({ hours: 1, job: 'report' });
    expect(stats.executions.SUCCEEDED).toBe(2);
    expect(stats.executions.CANCELLED).toBe(1);
    expect((await client.agents.list({ status: 'ONLINE' })).map((agent) => agent.handlers)).toEqual([['report']]);
  });

  it('submits batches and manages queues within the key’s role', async () => {
    const client = admin();
    await client.jobs.create({ name: 'email', mode: 'WORKER' });
    const batch = await client.queueBatch([
      { job: 'email', payload: { to: 'a' } },
      { job: 'email', payload: { to: 'b' }, options: { delay: 60_000, idempotencyKey: 'b-1' } },
      { job: 'missing' },
    ]);
    expect(batch.summary).toEqual({ created: 2, duplicate: 0, failed: 1 });
    expect(batch.results[2]).toMatchObject({ index: 2, outcome: 'error', error: { code: 'NOT_FOUND' } });
    await expect(client.queueBatch([])).rejects.toBeInstanceOf(ChronosConfigError);

    // Project keys act as MEMBER: pause and resume, but not create queues.
    await expect(client.queues.create({ name: 'emails' })).rejects.toBeInstanceOf(ChronosAuthError);
    const owner = admin(boot.credentials.userToken.token);
    expect(await owner.queues.create({ name: 'emails', concurrencyLimit: 2 })).toMatchObject({ name: 'emails', concurrencyLimit: 2, paused: false });
    expect((await client.queues.pause('emails')).paused).toBe(true);
    expect((await client.queues.resume('emails')).paused).toBe(false);
    expect((await owner.queues.update('emails', { concurrencyLimit: null })).concurrencyLimit).toBeNull();
    const queues = await client.queues.list();
    expect(queues.map((queue) => queue.name).sort()).toEqual(['default', 'emails']);
    expect((await client.queues.get('default')).counts).toMatchObject({ waiting: 1, delayed: 1 });
    await owner.queues.delete('emails');
    await expect(client.queues.get('emails')).rejects.toBeInstanceOf(ChronosNotFoundError);
  });

  it('previews schedules and lists upcoming runs', async () => {
    const client = admin();
    const preview = await client.schedules.preview({ cron: '*/15 * * * *', timezone: 'UTC' }, 4);
    expect(preview).toMatchObject({ type: 'CRON', timezone: 'UTC', inPast: false });
    expect(preview.occurrences).toHaveLength(4);
    await expect(client.schedules.preview({ cron: 'not a cron' })).rejects.toBeInstanceOf(ChronosValidationError);

    await client.jobs.create({ name: 'tick', mode: 'WORKER', schedule: { cron: '0 * * * *', timezone: 'UTC' } });
    const upcoming = await client.schedules.upcoming({ to: new Date(Date.now() + 3 * 3_600_000), job: 'tick' });
    expect(upcoming.occurrences.length).toBeGreaterThanOrEqual(2);
    expect(upcoming.occurrences.every((occurrence) => occurrence.jobName === 'tick')).toBe(true);
  });

  it('is available from an agent client with a project key', async () => {
    const chronos = new Chronos({ server, project: 'storefront', token: boot.credentials.agentToken.token, logger: false });
    const fromAgent = chronos.admin({ token: boot.credentials.projectKey.token });
    expect((await fromAgent.project()).slug).toBe('storefront');
    // Agent tokens cannot manage jobs.
    await expect(chronos.admin({ token: boot.credentials.agentToken.token }).jobs.list()).rejects.toBeInstanceOf(ChronosAuthError);
  });
});
