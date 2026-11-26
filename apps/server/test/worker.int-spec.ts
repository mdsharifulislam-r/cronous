import { createHmac } from 'node:crypto';
import { createServer, IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ExecutionStore, HttpExecutor, PermanentError, WorkerHandler, WorkerRuntime } from '@chronos/engine';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { RedisService } from '../src/infrastructure/redis/redis.service';
import { SchedulerHost } from '../src/infrastructure/engine/scheduler-host';
import { BootstrapService } from '../src/modules/bootstrap/bootstrap.service';
import { BootstrapResult, api, bearer, bootstrapInstallation, resetState, startTestApp } from './setup/test-app';
import { waitFor } from './setup/wait';

interface Received {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

describe('workers and webhook delivery', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let boot: BootstrapResult;
  let hook: Server;
  let hookUrl: string;
  let received: Received[];
  let respond: (request: Received) => { status: number; delayMs?: number };
  const runtimes: WorkerRuntime[] = [];

  beforeAll(async () => {
    app = await startTestApp({ CHRONOS_LEASE_MS: '5000' });
    prisma = app.get(PrismaService);
    hook = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        const entry = { method: request.method ?? '', url: request.url ?? '', headers: request.headers, body };
        received.push(entry);
        const { status, delayMs } = respond(entry);
        setTimeout(() => {
          if (!response.writableEnded) response.writeHead(status, { 'Content-Type': 'text/plain' }).end(`status ${status}`);
        }, delayMs ?? 0);
      });
    });
    await new Promise<void>((resolve) => hook.listen(0, '127.0.0.1', resolve));
    hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}`;
  });

  beforeEach(async () => {
    received = [];
    respond = () => ({ status: 200 });
    await resetState(app);
    await app.get(BootstrapService).ensureBootstrapToken();
    boot = await bootstrapInstallation(app);
  });

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  });

  afterAll(async () => {
    hook.closeAllConnections();
    await new Promise((resolve) => hook.close(resolve));
    await app.close();
  });

  const token = () => boot.credentials.userToken.token;
  const cycle = () => app.get(SchedulerHost).runtime.cycle();

  async function startWorker(options: { modes?: ('HTTP' | 'WORKER')[]; concurrency?: number; handlers?: Record<string, WorkerHandler>; http?: HttpExecutor; leaseMs?: number } = {}) {
    const redis = app.get(RedisService);
    const runtime = new WorkerRuntime(
      {
        prisma,
        keyspace: redis.keyspace,
        workerConnection: () => redis.createConnection('worker'),
        http: options.http ?? new HttpExecutor({ allowPrivate: true, allowedCidrs: ['127.0.0.1/32'] }),
        ...(options.handlers ? { handlers: options.handlers } : {}),
      },
      { modes: options.modes ?? ['HTTP'], concurrency: options.concurrency ?? 5, leaseMs: options.leaseMs ?? 5000, heartbeatMs: 1000, version: 'test' },
    );
    await runtime.start();
    runtimes.push(runtime);
    return runtime;
  }

  async function createJob(body: Record<string, unknown>) {
    const response = await api(app).post(`/v1/projects/${boot.project.id}/jobs`).set(...bearer(token())).send(body);
    if (response.status !== 201) throw new Error(`create job failed: ${response.status} ${JSON.stringify(response.body)}`);
    return response.body.data as { id: string };
  }

  async function trigger(jobId: string, body: Record<string, unknown> = {}) {
    const response = await api(app).post(`/v1/projects/${boot.project.id}/jobs/${jobId}/trigger`).set(...bearer(token())).send(body).expect(201);
    await cycle();
    return response.body.data.execution.id as string;
  }

  async function settled(id: string, statuses: string[], options: { redispatch?: boolean; timeoutMs?: number } = {}) {
    return waitFor(
      async () => {
        if (options.redispatch) await cycle();
        const execution = await prisma.jobExecution.findUniqueOrThrow({ where: { id }, include: { attempts: { orderBy: { attemptNumber: 'asc' } } } });
        return statuses.includes(execution.status) ? execution : null;
      },
      { timeoutMs: options.timeoutMs ?? 15_000, intervalMs: 100, message: `execution ${id} -> ${statuses.join('|')}` },
    );
  }

  describe('HTTP webhooks (Mode A)', () => {
    it('delivers a signed request with payload, headers and auth, and records the response', async () => {
      await startWorker();
      const job = await createJob({
        name: 'hook',
        mode: 'HTTP',
        http: {
          url: `${hookUrl}/run?x=1`,
          method: 'POST',
          headers: { 'X-Custom': 'yes' },
          auth: { type: 'bearer', token: 'downstream-token' },
          signingSecret: 'signing-secret-0123456789',
        },
        payload: { report: 'daily' },
      });
      const id = await trigger(job.id);
      const execution = await settled(id, ['SUCCEEDED']);
      expect(execution.attempts[0]).toMatchObject({ status: 'SUCCEEDED', httpStatus: 200 });
      expect(execution.result).toEqual({ status: 200, body: 'status 200' });

      const request = received[0]!;
      expect(request.url).toBe('/run?x=1');
      expect(JSON.parse(request.body)).toEqual({ report: 'daily' });
      expect(request.headers).toMatchObject({
        'x-custom': 'yes',
        authorization: 'Bearer downstream-token',
        'x-chronos-execution-id': id,
        'x-chronos-attempt': '1',
        'content-type': 'application/json',
      });
      const [t, v1] = String(request.headers['x-chronos-signature']).split(',');
      const timestamp = t!.slice(2);
      expect(v1).toBe(`v1=${createHmac('sha256', 'signing-secret-0123456789').update(`${timestamp}.${request.body}`).digest('hex')}`);
    });

    it('retries 5xx responses and does not retry 4xx responses', async () => {
      await startWorker();
      let calls = 0;
      respond = (request) => (request.url === '/flaky' ? { status: ++calls === 1 ? 503 : 200 } : { status: 422 });
      const flaky = await createJob({ name: 'flaky', mode: 'HTTP', retryBackoffMs: 0, retryBackoffMaxMs: 0, http: { url: `${hookUrl}/flaky` } });
      const invalid = await createJob({ name: 'invalid', mode: 'HTTP', maxAttempts: 5, http: { url: `${hookUrl}/invalid` } });

      const retried = await settled(await trigger(flaky.id), ['SUCCEEDED'], { redispatch: true });
      expect(retried.attempts.map((a) => [a.status, a.httpStatus])).toEqual([
        ['FAILED', 503],
        ['SUCCEEDED', 200],
      ]);

      const failed = await settled(await trigger(invalid.id), ['FAILED']);
      expect(failed.attempts).toHaveLength(1);
      expect(failed.attempts[0]).toMatchObject({ errorCode: 'HTTP_422', httpStatus: 422 });
    });

    it('times out slow endpoints and dead-letters after the last attempt', async () => {
      await startWorker();
      respond = () => ({ status: 200, delayMs: 4000 });
      const job = await createJob({ name: 'slow', mode: 'HTTP', timeoutMs: 1000, maxAttempts: 1, http: { url: `${hookUrl}/slow` } });
      const execution = await settled(await trigger(job.id), ['DEAD_LETTERED']);
      expect(execution.attempts[0]).toMatchObject({ status: 'TIMED_OUT', errorCode: 'TIMEOUT' });
    });

    it('blocks internal destinations (SSRF), including via DNS names', async () => {
      await startWorker({ http: new HttpExecutor({ allowPrivate: false, allowedCidrs: [] }) });
      const metadata = await createJob({ name: 'metadata', mode: 'HTTP', http: { url: 'http://169.254.169.254/latest/meta-data/' } });
      const loopbackName = await createJob({ name: 'loopback', mode: 'HTTP', http: { url: `${hookUrl.replace('127.0.0.1', 'localhost')}/x` } });

      for (const job of [metadata, loopbackName]) {
        const execution = await settled(await trigger(job.id), ['FAILED']);
        expect(execution.attempts[0]?.errorCode).toBe('BLOCKED_DESTINATION');
      }
      expect(received).toHaveLength(0);
    });
  });

  describe('central workers (Mode C)', () => {
    it('runs registered handlers within the concurrency limit, each execution exactly once', async () => {
      let running = 0;
      let maxRunning = 0;
      const calls = new Map<string, number>();
      const handler: WorkerHandler = async (ctx) => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        calls.set(ctx.executionId, (calls.get(ctx.executionId) ?? 0) + 1);
        await new Promise((resolve) => setTimeout(resolve, 400));
        running -= 1;
        await ctx.log('INFO', 'processed', { attempt: ctx.attempt });
        return { ok: true };
      };
      await startWorker({ modes: ['WORKER'], concurrency: 2, handlers: { crunch: handler } });
      await startWorker({ modes: ['WORKER'], concurrency: 2, handlers: { crunch: handler } });

      const job = await createJob({ name: 'crunch', mode: 'WORKER' });
      // Create all executions first and dispatch them together, so the workers receive them
      // at once (dispatching one by one can let each finish before the next exists).
      const ids: string[] = [];
      for (let i = 0; i < 10; i += 1) {
        const response = await api(app).post(`/v1/projects/${boot.project.id}/jobs/${job.id}/trigger`).set(...bearer(token())).send({}).expect(201);
        ids.push(response.body.data.execution.id as string);
      }
      await cycle();
      for (const id of ids) await settled(id, ['SUCCEEDED'], { timeoutMs: 30_000 });

      expect(maxRunning).toBeLessThanOrEqual(4); // 2 workers x concurrency 2
      expect(maxRunning).toBeGreaterThan(1);
      expect([...calls.values()].every((count) => count === 1)).toBe(true);
      expect(calls.size).toBe(10);
      const workers = await api(app).get('/v1/workers').set(...bearer(token())).expect(200);
      expect(workers.body.data.filter((w: { status: string }) => w.status === 'ONLINE')).toHaveLength(2);
    });

    it('ignores duplicate deliveries of the same execution', async () => {
      let calls = 0;
      const runtime = await startWorker({ modes: ['WORKER'], handlers: { once: async () => void (calls += 1) } });
      const job = await createJob({ name: 'once', mode: 'WORKER' });
      const id = await trigger(job.id);
      await settled(id, ['SUCCEEDED']);
      // Re-deliver the same attempt twice concurrently (e.g. a stalled BullMQ job).
      const fake = { data: { executionId: id, attempt: 1 } } as Parameters<WorkerRuntime['process']>[0];
      expect(await Promise.all([runtime.process(fake), runtime.process(fake)])).toEqual(['skipped', 'skipped']);
      expect(calls).toBe(1);
    });

    it('honours permanent errors from handlers', async () => {
      await startWorker({ modes: ['WORKER'], handlers: { reject: async () => { throw new PermanentError('invalid account', 'INVALID_ACCOUNT'); } } });
      const job = await createJob({ name: 'reject', mode: 'WORKER', maxAttempts: 5 });
      const execution = await settled(await trigger(job.id), ['FAILED']);
      expect(execution.attempts).toHaveLength(1);
      expect(execution.attempts[0]?.errorCode).toBe('INVALID_ACCOUNT');
    });

    it('recovers executions abandoned by a crashed worker', async () => {
      const job = await createJob({ name: 'recover', mode: 'WORKER', retryBackoffMs: 0, retryBackoffMaxMs: 0 });
      const id = await trigger(job.id);
      // A worker claims the execution and dies without renewing its lease.
      const dead = await prisma.worker.create({ data: { instanceId: 'dead-worker', version: 'test', concurrency: 1, lastHeartbeatAt: new Date(Date.now() - 3600_000) } });
      const claimed = await new ExecutionStore(prisma).claim(id, { kind: 'worker', workerId: dead.id }, 1000);
      expect(claimed?.attempt).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 1200));

      const reaped = await app.get(SchedulerHost).runtime.reaper.reapOnce();
      expect(reaped.expiredLeases).toBe(1);
      expect(reaped.staleWorkers).toBe(1);
      expect((await prisma.worker.findUniqueOrThrow({ where: { id: dead.id } })).status).toBe('OFFLINE');

      await startWorker({ modes: ['WORKER'], handlers: { recover: async () => 'recovered' } });
      const execution = await settled(id, ['SUCCEEDED'], { redispatch: true });
      expect(execution.attempts.map((a) => [a.status, a.errorCode])).toEqual([
        ['ABANDONED', 'LEASE_EXPIRED'],
        ['SUCCEEDED', null],
      ]);
    });

    it('enforces a server-side hard timeout on executors that keep renewing', async () => {
      const job = await createJob({ name: 'stuck', mode: 'WORKER', timeoutMs: 1000, maxAttempts: 1 });
      const id = await trigger(job.id);
      const zombie = await prisma.worker.create({ data: { instanceId: 'zombie', version: 'test', concurrency: 1 } });
      await new ExecutionStore(prisma).claim(id, { kind: 'worker', workerId: zombie.id }, 600_000);
      await prisma.jobAttempt.updateMany({ where: { executionId: id }, data: { startedAt: new Date(Date.now() - 3600_000) } });
      const reaped = await app.get(SchedulerHost).runtime.reaper.reapOnce();
      expect(reaped.timedOut).toBe(1);
      const execution = await settled(id, ['DEAD_LETTERED']);
      expect(execution.attempts[0]).toMatchObject({ status: 'TIMED_OUT', errorCode: 'TIMEOUT' });
    });

    it('aborts a running handler when its execution is cancelled', async () => {
      let aborted = false;
      await startWorker({
        modes: ['WORKER'],
        handlers: { cancellable: (ctx) => new Promise((resolve) => ctx.signal.addEventListener('abort', () => resolve((aborted = true)))) },
      });
      const job = await createJob({ name: 'cancellable', mode: 'WORKER', timeoutMs: 60_000 });
      const id = await trigger(job.id);
      await settled(id, ['RUNNING']);
      await api(app).post(`/v1/projects/${boot.project.id}/executions/${id}/cancel`).set(...bearer(token())).expect(200);
      await waitFor(() => aborted, { timeoutMs: 10_000, message: 'lease-loss abort' });
      expect((await prisma.jobExecution.findUniqueOrThrow({ where: { id } })).status).toBe('CANCELLED');
    });

    it('drains running executions on graceful shutdown', async () => {
      const runtime = await startWorker({
        modes: ['WORKER'],
        handlers: { draining: async () => new Promise((resolve) => setTimeout(() => resolve('drained'), 500)) },
      });
      const job = await createJob({ name: 'draining', mode: 'WORKER' });
      const id = await trigger(job.id);
      await settled(id, ['RUNNING']);
      await runtime.stop();
      runtimes.splice(runtimes.indexOf(runtime), 1);
      expect((await prisma.jobExecution.findUniqueOrThrow({ where: { id } })).status).toBe('SUCCEEDED');
      expect((await prisma.worker.findUniqueOrThrow({ where: { id: runtime.workerId! } })).status).toBe('OFFLINE');
    });
  });
});
