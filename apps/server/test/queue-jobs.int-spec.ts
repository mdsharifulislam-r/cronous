import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@chronos/database';
import { Dispatcher, ExecutionQueues, ExecutionStore, HttpExecutor, WorkerHandler, WorkerRuntime, bullJobId } from '@chronos/engine';
import { Chronos, ChronosConfigError, ChronosNotFoundError, ChronosValidationError } from '@sharifulislam1/cronous';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { RedisService } from '../src/infrastructure/redis/redis.service';
import { SchedulerHost } from '../src/infrastructure/engine/scheduler-host';
import { BootstrapService } from '../src/modules/bootstrap/bootstrap.service';
import { BootstrapResult, api, bearer, bootstrapInstallation, resetState, startTestApp } from './setup/test-app';
import { waitFor } from './setup/wait';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('queue jobs (immediate and delayed submissions)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let server: string;
  let boot: BootstrapResult;
  let base: string;
  let hook: Server;
  let hookUrl: string;
  let hookBodies: string[];
  const runtimes: WorkerRuntime[] = [];
  const agents: Chronos[] = [];

  beforeAll(async () => {
    app = await startTestApp({ CHRONOS_AGENT_HEARTBEAT_MS: '1000', CHRONOS_LEASE_MS: '5000' });
    await app.listen(0, '127.0.0.1');
    server = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
    hook = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        hookBodies.push(body);
        response.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((resolve) => hook.listen(0, '127.0.0.1', resolve));
    hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`;
  });

  beforeEach(async () => {
    hookBodies = [];
    await resetState(app);
    await app.get(BootstrapService).ensureBootstrapToken();
    boot = await bootstrapInstallation(app);
    base = `/v1/projects/${boot.project.id}`;
  });

  afterEach(async () => {
    await Promise.all(agents.splice(0).map((agent) => agent.stop({ timeoutMs: 1000 })));
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  });

  afterAll(async () => {
    hook.closeAllConnections();
    await new Promise((resolve) => hook.close(resolve));
    await app.close();
  });

  const userToken = () => boot.credentials.userToken.token;
  const cycle = () => app.get(SchedulerHost).runtime.cycle();
  const execution = (id: string) => prisma.jobExecution.findUniqueOrThrow({ where: { id }, include: { attempts: true } });

  async function createJob(body: Record<string, unknown>) {
    const response = await api(app).post(`${base}/jobs`).set(...bearer(userToken())).send(body);
    if (response.status !== 201) throw new Error(`create job failed: ${response.status} ${JSON.stringify(response.body)}`);
    return response.body.data as { id: string; name: string; queue: string };
  }

  async function createQueue(body: Record<string, unknown>) {
    const response = await api(app).post(`${base}/queues`).set(...bearer(userToken())).send(body);
    if (response.status !== 201) throw new Error(`create queue failed: ${response.status} ${JSON.stringify(response.body)}`);
    return response.body.data as { id: string; name: string };
  }

  function submit(body: Record<string, unknown>, token = userToken()) {
    return api(app).post(`${base}/queue`).set(...bearer(token)).send(body);
  }

  async function submitOk(body: Record<string, unknown>) {
    const response = await submit(body);
    if (response.status !== 201) throw new Error(`submit failed: ${response.status} ${JSON.stringify(response.body)}`);
    return response.body.data.execution as { id: string; status: string; delayed: boolean; queue: string; priority: number };
  }

  async function startWorker(handlers: Record<string, WorkerHandler>, modes: ('HTTP' | 'WORKER')[] = ['WORKER'], concurrency = 5) {
    const redis = app.get(RedisService);
    const runtime = new WorkerRuntime(
      {
        prisma,
        keyspace: redis.keyspace,
        workerConnection: () => redis.createConnection('worker'),
        http: new HttpExecutor({ allowPrivate: true, allowedCidrs: ['127.0.0.1/32'] }),
        handlers,
      },
      { modes, concurrency, leaseMs: 5000, heartbeatMs: 1000, version: 'test' },
    );
    await runtime.start();
    runtimes.push(runtime);
    return runtime;
  }

  function agent(project = 'storefront'): Chronos {
    const chronos = new Chronos({ server, project, token: boot.credentials.agentToken.token, logger: false, reconnect: { initialDelayMs: 50, maxDelayMs: 200 } });
    chronos.on('error', () => undefined);
    agents.push(chronos);
    return chronos;
  }

  const statuses = async (ids: string[]) =>
    (await prisma.jobExecution.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } })).reduce<Record<string, number>>(
      (counts, row) => ({ ...counts, [row.status]: (counts[row.status] ?? 0) + 1 }),
      {},
    );

  describe('submission API', () => {
    it('submits immediately with user tokens, project keys and agent tokens', async () => {
      await createJob({ name: 'send-email', mode: 'WORKER' });
      const byUser = await submit({ job: 'send-email', payload: { to: 'a@example.com' } }).expect(201);
      expect(byUser.body.data).toMatchObject({
        created: true,
        execution: { jobName: 'send-email', queue: 'default', status: 'PENDING', trigger: 'QUEUE', priority: 50, delayed: false },
      });
      await submit({ job: 'send-email' }, boot.credentials.projectKey.token).expect(201);
      await submit({ job: 'send-email' }, boot.credentials.agentToken.token).expect(201);

      // Agent tokens may submit, but not read or manage.
      await api(app).get(`${base}/executions`).set(...bearer(boot.credentials.agentToken.token)).expect(403);
      await api(app).get(`${base}/jobs`).set(...bearer(boot.credentials.agentToken.token)).expect(403);
      await api(app).get(`${base}/queues`).set(...bearer(boot.credentials.agentToken.token)).expect(403);

      const stored = await execution(byUser.body.data.execution.id);
      expect(stored.payload).toEqual({ to: 'a@example.com' });
      await cycle();
      expect((await execution(stored.id)).status).toBe('QUEUED');
    });

    it('is idempotent, including for concurrent requests with the same key', async () => {
      await createJob({ name: 'once', mode: 'WORKER' });
      const first = await submit({ job: 'once', idempotencyKey: 'order-42' }).expect(201);
      const again = await submit({ job: 'once', idempotencyKey: 'order-42', payload: { ignored: true } }).expect(200);
      expect(again.body.data).toMatchObject({ created: false, execution: { id: first.body.data.execution.id, idempotencyKey: 'order-42' } });

      const racing = await Promise.all(Array.from({ length: 8 }, () => submit({ job: 'once', idempotencyKey: 'race-1' })));
      expect(racing.map((response) => response.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
      expect(new Set(racing.map((response) => response.body.data.execution.id)).size).toBe(1);
      expect(await prisma.jobExecution.count()).toBe(2);
    });

    it('rejects unknown jobs and queues, disabled jobs and invalid submissions', async () => {
      await createJob({ name: 'off', mode: 'WORKER', enabled: false });
      await createJob({ name: 'on', mode: 'WORKER' });
      expect((await submit({ job: 'missing' }).expect(404)).body.error.message).toMatch(/missing/);
      expect((await submit({ job: 'on', queue: 'nope' }).expect(404)).body.error.message).toMatch(/nope/);
      await submit({ job: 'off' }).expect(409);
      await submit({ job: 'on', unknown: 1 }).expect(400);
      await submit({ job: 'on', delayMs: 366 * 86_400_000 }).expect(400);
      await submit({ job: 'on', delayMs: 1000, runAt: new Date(Date.now() + 5000).toISOString() }).expect(400);
      await submit({ job: 'on', priority: 101 }).expect(400);
      await submit({ job: 'on', retryBackoffMs: 5000, retryBackoffMaxMs: 1000 }).expect(400);
      await submit({ job: 'on', queue: 'Not A Queue' }).expect(400);
    });

    it('submits batches with per-item results', async () => {
      await createJob({ name: 'bulk', mode: 'WORKER' });
      const response = await api(app)
        .post(`${base}/queue/batch`)
        .set(...bearer(userToken()))
        .send({ items: [{ job: 'bulk', idempotencyKey: 'b1' }, { job: 'missing' }, { job: 'bulk', idempotencyKey: 'b1' }, { job: 'bulk', delayMs: 60_000 }] })
        .expect(200);
      expect(response.body.data.summary).toEqual({ created: 2, duplicate: 1, failed: 1 });
      expect(response.body.data.results.map((result: { outcome: string }) => result.outcome)).toEqual(['created', 'error', 'duplicate', 'created']);
      expect(response.body.data.results[1].error).toMatchObject({ status: 404, code: 'NOT_FOUND' });
      expect(response.body.data.results[3].execution.delayed).toBe(true);
      await api(app).post(`${base}/queue/batch`).set(...bearer(userToken())).send({ items: [] }).expect(400);
    });
  });

  describe('delayed submissions', () => {
    it('waits in PostgreSQL until due, then follows the normal pipeline', async () => {
      await createJob({ name: 'remind', mode: 'WORKER' });
      const delayed = await submitOk({ job: 'remind', delayMs: 1500 });
      expect(delayed).toMatchObject({ status: 'PENDING', delayed: true });
      const past = await submitOk({ job: 'remind', runAt: new Date(Date.now() - 60_000).toISOString() });
      expect(past.delayed).toBe(false);

      await cycle();
      expect((await execution(delayed.id)).status).toBe('PENDING'); // not early
      expect((await execution(past.id)).status).toBe('QUEUED');

      const listed = await api(app).get(`${base}/executions?delayed=true`).set(...bearer(userToken())).expect(200);
      expect(listed.body.data.items.map((item: { id: string }) => item.id)).toEqual([delayed.id]);
      const queue = await api(app).get(`${base}/queues/default`).set(...bearer(userToken())).expect(200);
      expect(queue.body.data.counts).toMatchObject({ delayed: 1, queued: 1 });

      await sleep(1600);
      await cycle();
      const due = await execution(delayed.id);
      expect(due.status).toBe('QUEUED');
      const scheduledFor = due.scheduledFor.getTime();
      expect(scheduledFor - due.createdAt.getTime()).toBeGreaterThanOrEqual(1400);
    });

    it('never runs a delayed execution that was cancelled', async () => {
      await createJob({ name: 'cancel-me', mode: 'WORKER' });
      const delayed = await submitOk({ job: 'cancel-me', delayMs: 300 });
      await api(app).post(`${base}/executions/${delayed.id}/cancel`).set(...bearer(boot.credentials.agentToken.token)).expect(200);
      await sleep(400);
      await cycle();
      const after = await execution(delayed.id);
      expect(after.status).toBe('CANCELLED');
      expect(after.attempts).toHaveLength(0);
    });

    it('still runs delayed jobs after Redis lost all Chronos keys', async () => {
      await createJob({ name: 'durable', mode: 'WORKER' });
      const delayed = await submitOk({ job: 'durable', delayMs: 300 });
      const redis = app.get(RedisService);
      const keys = await redis.client.keys(redis.keyspace.pattern);
      if (keys.length) await redis.client.del(...keys);
      await sleep(400);
      await cycle();
      const queued = await execution(delayed.id);
      expect(queued.status).toBe('QUEUED');
      expect(await app.get(ExecutionQueues).queue('WORKER').getJob(bullJobId(delayed.id, 1))).toBeTruthy();
    });
  });

  describe('admission control', () => {
    it('enforces a queue concurrency limit across concurrent dispatchers', async () => {
      await createQueue({ name: 'emails', concurrencyLimit: 2 });
      await createJob({ name: 'mail', mode: 'WORKER', queue: 'emails' });
      const ids: string[] = [];
      for (let i = 0; i < 6; i += 1) ids.push((await submitOk({ job: 'mail' })).id);

      const queues = app.get(ExecutionQueues);
      const dispatchers = Array.from({ length: 4 }, () => new Dispatcher({ prisma, queues, notifyAgents: async () => undefined }));
      await Promise.all(dispatchers.map((dispatcher) => dispatcher.dispatch()));
      await Promise.all(dispatchers.map((dispatcher) => dispatcher.dispatch()));
      expect(await statuses(ids)).toEqual({ QUEUED: 2, PENDING: 4 });

      const counts = (await api(app).get(`${base}/queues/emails`).set(...bearer(userToken())).expect(200)).body.data.counts;
      expect(counts).toMatchObject({ waiting: 4, queued: 2, running: 0 });

      // A finished execution frees its slot.
      const queued = await prisma.jobExecution.findFirstOrThrow({ where: { id: { in: ids }, status: 'QUEUED' } });
      await prisma.jobExecution.update({ where: { id: queued.id }, data: { status: 'SUCCEEDED', finishedAt: new Date() } });
      await cycle();
      expect(await statuses(ids)).toEqual({ SUCCEEDED: 1, QUEUED: 2, PENDING: 3 });

      // Raising the limit admits more.
      await api(app).patch(`${base}/queues/emails`).set(...bearer(userToken())).send({ concurrencyLimit: 10 }).expect(200);
      await cycle();
      expect(await statuses(ids)).toEqual({ SUCCEEDED: 1, QUEUED: 5 });
    });

    it('enforces a job maxConcurrency in an unlimited queue', async () => {
      await createJob({ name: 'single', mode: 'WORKER', maxConcurrency: 1 });
      const ids = [(await submitOk({ job: 'single' })).id, (await submitOk({ job: 'single' })).id, (await submitOk({ job: 'single' })).id];
      await cycle();
      expect(await statuses(ids)).toEqual({ QUEUED: 1, PENDING: 2 });
    });

    it('does not let a saturated queue starve other queues', async () => {
      await createQueue({ name: 'slow', concurrencyLimit: 1 });
      const slow = await createJob({ name: 'slow-job', mode: 'WORKER', queue: 'slow' });
      const fast = await createJob({ name: 'fast-job', mode: 'WORKER' });
      const slowQueue = await prisma.queue.findFirstOrThrow({ where: { name: 'slow' } });
      const defaultQueue = await prisma.queue.findFirstOrThrow({ where: { name: 'default' } });
      const now = new Date(Date.now() - 1000);
      const row = (jobId: string, queueId: string, key: string, priority: number): Prisma.JobExecutionCreateManyInput => ({
        jobId, projectId: boot.project.id, queueId, trigger: 'QUEUE', scheduledFor: now, idempotencyKey: key, mode: 'WORKER',
        priority, maxAttempts: 1, timeoutMs: 10_000, retryBackoffMs: 0, retryBackoffMaxMs: 0, nextAttemptAt: now,
      });
      // 450 high-priority rows in a queue that admits one, more than a dispatcher batch (200).
      await prisma.jobExecution.createMany({ data: Array.from({ length: 450 }, (_, i) => row(slow.id, slowQueue.id, `s${i}`, 90)) });
      await prisma.jobExecution.createMany({ data: [row(fast.id, defaultQueue.id, 'f1', 10)] });

      await cycle();
      expect(await prisma.jobExecution.count({ where: { jobId: slow.id, status: 'QUEUED' } })).toBe(1);
      expect(await prisma.jobExecution.count({ where: { jobId: fast.id, status: 'QUEUED' } })).toBe(1);
    });

    it('pauses and resumes a queue', async () => {
      await createQueue({ name: 'reports' });
      await createJob({ name: 'report', mode: 'WORKER', queue: 'reports' });
      await api(app).post(`${base}/queues/reports/pause`).set(...bearer(boot.credentials.projectKey.token)).expect(200);
      const pending = await submitOk({ job: 'report' }); // accepted while paused
      await cycle();
      expect((await execution(pending.id)).status).toBe('PENDING');
      const resumed = await api(app).post(`${base}/queues/reports/resume`).set(...bearer(userToken())).expect(200);
      expect(resumed.body.data.paused).toBe(false);
      await cycle();
      expect((await execution(pending.id)).status).toBe('QUEUED');
    });

    it('admits higher priority first and passes priority to BullMQ', async () => {
      await createQueue({ name: 'one-at-a-time', concurrencyLimit: 1 });
      await createJob({ name: 'ranked', mode: 'WORKER', queue: 'one-at-a-time', priority: 20 });
      await api(app).post(`${base}/queues/one-at-a-time/pause`).set(...bearer(userToken())).expect(200);
      const low = await submitOk({ job: 'ranked' });
      const high = await submitOk({ job: 'ranked', priority: 95 });
      const mid = await submitOk({ job: 'ranked', priority: 60 });
      expect([low.priority, high.priority, mid.priority]).toEqual([20, 95, 60]);
      await api(app).post(`${base}/queues/one-at-a-time/resume`).set(...bearer(userToken())).expect(200);
      await cycle();
      expect((await execution(high.id)).status).toBe('QUEUED');
      expect((await execution(mid.id)).status).toBe('PENDING');
      const bull = await app.get(ExecutionQueues).queue('WORKER').getJob(bullJobId(high.id, 1));
      expect(bull?.opts.priority).toBe(6); // 101 - 95
    });
  });

  describe('execution modes', () => {
    it('runs a central-worker job with per-submission retry overrides until dead-lettered', async () => {
      let calls = 0;
      await createJob({ name: 'flaky', mode: 'WORKER', maxAttempts: 5 });
      await startWorker({
        flaky: async () => {
          calls += 1;
          throw new Error('boom');
        },
      });
      const submitted = await submitOk({ job: 'flaky', maxAttempts: 2, retryBackoffMs: 0, retryBackoffMaxMs: 0 });
      const final = await waitFor(
        async () => {
          await cycle();
          const row = await execution(submitted.id);
          return row.status === 'DEAD_LETTERED' ? row : null;
        },
        { timeoutMs: 15_000, intervalMs: 100, message: 'dead letter' },
      );
      expect(final.attempts).toHaveLength(2);
      expect(final.maxAttempts).toBe(2);
      expect(calls).toBe(2);
    });

    it('delivers an HTTP job with the submitted payload', async () => {
      await createJob({ name: 'hook', mode: 'HTTP', http: { url: hookUrl, method: 'POST' } });
      await startWorker({}, ['HTTP']);
      const submitted = await submitOk({ job: 'hook', payload: { order: 7 } });
      await waitFor(async () => {
        await cycle();
        return (await execution(submitted.id)).status === 'SUCCEEDED';
      }, { timeoutMs: 15_000, intervalMs: 100, message: 'webhook delivered' });
      expect(hookBodies.some((body) => body.includes('"order":7'))).toBe(true);
    });

    it('runs agent jobs submitted from the SDK, immediately and delayed, with schema validation', async () => {
      const seen: unknown[] = [];
      const worker = agent();
      worker.task('send-email', { queue: 'emails', priority: 70, payloadSchema: { type: 'object', required: ['to'], properties: { to: { type: 'string', format: 'email' } } } }, async (ctx) => {
        seen.push(ctx.payload);
        return { sent: true };
      });
      await worker.start();

      // A different process that only submits: no start(), no tasks.
      const producer = agent();
      const now = await producer.queue('send-email', { to: 'a@example.com' });
      expect(now).toMatchObject({ jobName: 'send-email', queue: 'emails', priority: 70, delayed: false, created: true });
      const later = await producer.queue('send-email', { to: 'b@example.com' }, { delay: 800 });
      expect(later.delayed).toBe(true);

      await expect(producer.queue('send-email', { to: 'not-an-email' })).rejects.toBeInstanceOf(ChronosValidationError);
      await expect(producer.queue('send-email', {})).rejects.toMatchObject({ details: [{ path: 'payload', message: expect.stringContaining('to') }] });
      await expect(producer.queue('no-such-task', {})).rejects.toBeInstanceOf(ChronosNotFoundError);
      await expect(producer.queue('send-email', {}, { delay: -1 })).rejects.toBeInstanceOf(ChronosValidationError);
      await expect(agent('wrong-project').queue('send-email', { to: 'a@example.com' })).rejects.toBeInstanceOf(ChronosConfigError);

      for (const id of [now.id, later.id]) {
        await waitFor(async () => {
          await cycle();
          return (await execution(id)).status === 'SUCCEEDED';
        }, { timeoutMs: 15_000, intervalMs: 100, message: `agent execution ${id}` });
      }
      expect(seen).toEqual([{ to: 'a@example.com' }, { to: 'b@example.com' }]);

      // SDK cancel: true before start, false once finished.
      const pending = await producer.queue('send-email', { to: 'c@example.com' }, { delay: 60_000 });
      expect(await producer.cancel(pending.id)).toBe(true);
      expect(await producer.cancel(now.id)).toBe(false);
    });

    it('keeps the SDK call idempotent with an explicit key', async () => {
      const producer = agent();
      await createJob({ name: 'charge', mode: 'WORKER' });
      const first = await producer.queue('charge', { amount: 5 }, { idempotencyKey: 'invoice-9' });
      const second = await producer.queue('charge', { amount: 5 }, { idempotencyKey: 'invoice-9' });
      expect(second).toMatchObject({ id: first.id, created: false });
    });

    it('gives scheduled executions the queue and priority of their job', async () => {
      await createQueue({ name: 'nightly', defaultPriority: 30 });
      const job = await createJob({ name: 'nightly-sync', mode: 'WORKER', queue: 'nightly', schedule: { cron: '* * * * *', timezone: 'UTC' } });
      // The start of the current minute is a real occurrence of the cron, within the misfire grace.
      await prisma.jobSchedule.update({ where: { jobId: job.id }, data: { nextRunAt: new Date(Math.floor(Date.now() / 60_000) * 60_000) } });
      await cycle();
      const scheduled = await prisma.jobExecution.findFirstOrThrow({ where: { jobId: job.id }, include: { queue: true } });
      expect(scheduled).toMatchObject({ trigger: 'SCHEDULE', priority: 30, queue: { name: 'nightly' }, retryBackoffMs: 10_000 });
    });
  });

  describe('queues and job configuration', () => {
    it('manages queues with role checks and safe deletion', async () => {
      const listed = await api(app).get(`${base}/queues`).set(...bearer(userToken())).expect(200);
      expect(listed.body.data.map((queue: { name: string }) => queue.name)).toEqual(['default']);
      await createQueue({ name: 'emails', concurrencyLimit: 3, defaultPriority: 70 });
      await api(app).post(`${base}/queues`).set(...bearer(userToken())).send({ name: 'emails' }).expect(409);
      await api(app).post(`${base}/queues`).set(...bearer(boot.credentials.projectKey.token)).send({ name: 'other' }).expect(403);
      await createJob({ name: 'mailer', mode: 'WORKER', queue: 'emails' });
      await api(app).delete(`${base}/queues/emails`).set(...bearer(userToken())).expect(409);
      await api(app).delete(`${base}/queues/default`).set(...bearer(userToken())).expect(409);
      await createQueue({ name: 'empty' });
      await api(app).delete(`${base}/queues/empty`).set(...bearer(userToken())).expect(204);
      await api(app).get(`${base}/queues/empty`).set(...bearer(userToken())).expect(404);
      const missing = await api(app).post(`${base}/jobs`).set(...bearer(userToken())).send({ name: 'bad-queue', mode: 'WORKER', queue: 'missing' }).expect(400);
      expect(missing.body.error.message).toMatch(/Queue "missing" does not exist/);
      const filtered = await api(app).get(`${base}/jobs?queue=emails`).set(...bearer(userToken())).expect(200);
      expect(filtered.body.data.map((job: { name: string; queue: string }) => [job.name, job.queue])).toEqual([['mailer', 'emails']]);
    });

    it('validates payload schemas when saving jobs', async () => {
      const bad = await api(app).post(`${base}/jobs`).set(...bearer(userToken())).send({ name: 'x', mode: 'WORKER', payloadSchema: { type: 'no-such-type' } }).expect(400);
      expect(bad.body.error.message).toMatch(/payloadSchema/);
      await api(app)
        .post(`${base}/jobs`)
        .set(...bearer(userToken()))
        .send({ name: 'y', mode: 'WORKER', payloadSchema: { type: 'object', required: ['id'] }, payload: { other: 1 } })
        .expect(400);
      const ok = await createJob({ name: 'z', mode: 'WORKER', payloadSchema: { type: 'object', required: ['id'] }, payload: { id: 1 } });
      await submit({ job: 'z' }).expect(201); // the job's default payload is used and valid
      await submit({ job: 'z', payload: { nope: true } }).expect(400);
      await api(app).patch(`${base}/jobs/${ok.id}`).set(...bearer(userToken())).send({ payloadSchema: null }).expect(200);
      await submit({ job: 'z', payload: { nope: true } }).expect(201);
    });

    it('lets agent tokens cancel only executions that have not started', async () => {
      await createJob({ name: 'long', mode: 'WORKER' });
      const submitted = await submitOk({ job: 'long' });
      await cycle();
      await app.get(ExecutionStore).claim(submitted.id, { kind: 'worker', workerId: '00000000-0000-4000-8000-000000000001' }, 5000).catch(() => null);
      await prisma.jobExecution.update({ where: { id: submitted.id }, data: { status: 'RUNNING' } });
      await api(app).post(`${base}/executions/${submitted.id}/cancel`).set(...bearer(boot.credentials.agentToken.token)).expect(409);
      await api(app).post(`${base}/executions/${submitted.id}/cancel`).set(...bearer(userToken())).expect(200);
    });

    it('removes the BullMQ delivery when a queued execution is cancelled', async () => {
      await createJob({ name: 'drop', mode: 'WORKER' });
      const submitted = await submitOk({ job: 'drop' });
      await cycle();
      const queues = app.get(ExecutionQueues);
      expect(await queues.queue('WORKER').getJob(bullJobId(submitted.id, 1))).toBeTruthy();
      await api(app).post(`${base}/executions/${submitted.id}/cancel`).set(...bearer(userToken())).expect(200);
      expect(await queues.queue('WORKER').getJob(bullJobId(submitted.id, 1))).toBeFalsy();
    });
  });
});

describe('dispatcher wake-up', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    // A one-minute tick: only the wake-up signal can make immediate jobs start quickly.
    app = await startTestApp({ CHRONOS_EMBEDDED_SCHEDULER: 'true', CHRONOS_SCHEDULER_TICK_MS: '60000' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('dispatches an immediate submission without waiting for the next tick', async () => {
    const boot = await bootstrapInstallation(app);
    const base = `/v1/projects/${boot.project.id}`;
    await api(app).post(`${base}/jobs`).set(...bearer(boot.credentials.userToken.token)).send({ name: 'fast', mode: 'WORKER' }).expect(201);
    await sleep(500); // let the first cycle finish; the runtime now sleeps for 60s
    const started = Date.now();
    const response = await api(app).post(`${base}/queue`).set(...bearer(boot.credentials.userToken.token)).send({ job: 'fast' }).expect(201);
    const prisma = app.get(PrismaService);
    await waitFor(async () => (await prisma.jobExecution.findUniqueOrThrow({ where: { id: response.body.data.execution.id } })).status === 'QUEUED', {
      timeoutMs: 5000,
      intervalMs: 20,
      message: 'woken dispatch',
    });
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
