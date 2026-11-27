import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Chronos, ChronosConnectionError, NonRetryableError } from '@cronouss/cronous';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { SchedulerHost } from '../src/infrastructure/engine/scheduler-host';
import { BootstrapService } from '../src/modules/bootstrap/bootstrap.service';
import { AgentGateway } from '../src/modules/agents/agent.gateway';
import { BootstrapResult, api, bearer, bootstrapInstallation, resetState, startTestApp } from './setup/test-app';
import { waitFor } from './setup/wait';

describe('agent mode (SDK over WebSocket)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let server: string;
  let boot: BootstrapResult;
  const agents: Chronos[] = [];

  beforeAll(async () => {
    app = await startTestApp({ CHRONOS_AGENT_HEARTBEAT_MS: '1000', CHRONOS_LEASE_MS: '5000' });
    await app.listen(0, '127.0.0.1');
    server = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await resetState(app);
    await app.get(BootstrapService).ensureBootstrapToken();
    boot = await bootstrapInstallation(app);
  });

  afterEach(async () => {
    await Promise.all(agents.splice(0).map((agent) => agent.stop({ timeoutMs: 1000 })));
  });

  afterAll(async () => {
    await app.close();
  });

  function agent(overrides: Partial<ConstructorParameters<typeof Chronos>[0]> = {}): Chronos {
    const chronos = new Chronos({
      server,
      project: 'storefront',
      token: boot.credentials.agentToken.token,
      logger: false,
      reconnect: { initialDelayMs: 50, maxDelayMs: 200 },
      ...overrides,
    });
    agents.push(chronos);
    return chronos;
  }

  const cycle = () => app.get(SchedulerHost).runtime.cycle();

  async function trigger(name: string, body: Record<string, unknown> = {}) {
    const job = await prisma.job.findFirstOrThrow({ where: { name, projectId: boot.project.id } });
    const response = await api(app)
      .post(`/v1/projects/${boot.project.id}/jobs/${job.id}/trigger`)
      .set(...bearer(boot.credentials.userToken.token))
      .send(body)
      .expect(201);
    await cycle(); // dispatch -> wake-up signal -> agent session claims
    return response.body.data.execution.id as string;
  }

  async function executionWhen(id: string, predicate: (status: string) => boolean, timeoutMs = 15_000) {
    return waitFor(
      async () => {
        const execution = await prisma.jobExecution.findUniqueOrThrow({ where: { id }, include: { attempts: { orderBy: { attemptNumber: 'asc' } } } });
        return predicate(execution.status) ? execution : null;
      },
      { timeoutMs, message: `execution ${id}` },
    );
  }

  it('synchronises tasks on start and registers the agent', async () => {
    const chronos = agent({ timezone: 'Asia/Dhaka' });
    chronos.task('daily-report', { schedule: '0 2 * * *', maxAttempts: 2 }, async () => undefined);
    chronos.task('on-demand', async () => undefined);
    await chronos.start();
    expect(chronos.status).toBe('connected');

    const jobs = await prisma.job.findMany({ where: { projectId: boot.project.id }, include: { schedule: true }, orderBy: { name: 'asc' } });
    expect(jobs.map((job) => [job.name, job.mode, job.source])).toEqual([
      ['daily-report', 'AGENT', 'SDK'],
      ['on-demand', 'AGENT', 'SDK'],
    ]);
    expect(jobs[0]?.schedule).toMatchObject({ cronExpression: '0 2 * * *', timezone: 'Asia/Dhaka', state: 'ACTIVE' });
    expect(jobs[0]?.maxAttempts).toBe(2);

    const listed = await api(app).get(`/v1/projects/${boot.project.id}/agents`).set(...bearer(boot.credentials.userToken.token)).expect(200);
    expect(listed.body.data).toEqual([expect.objectContaining({ status: 'ONLINE', handlers: ['daily-report', 'on-demand'] })]);
  });

  it('does not move nextRunAt when the same definitions are re-synced', async () => {
    const first = agent();
    first.task('stable', { schedule: '0 2 * * *', timezone: 'UTC' }, async () => undefined);
    await first.start();
    const before = await prisma.jobSchedule.findFirstOrThrow();
    await first.stop();

    const second = agent();
    second.task('stable', { schedule: '0 2 * * *', timezone: 'UTC' }, async () => undefined);
    await second.start();
    const after = await prisma.jobSchedule.findFirstOrThrow();
    expect(after.nextRunAt).toEqual(before.nextRunAt);
    expect(after.version).toBe(before.version);
  });

  it('runs the handler in-process and records success, payload, output and logs', async () => {
    const seen: unknown[] = [];
    const chronos = agent();
    chronos.task('greet', async (ctx) => {
      seen.push({ payload: ctx.payload, attempt: ctx.attempt, key: ctx.idempotencyKey });
      ctx.log.info('hello from the handler', { n: 1 });
      return { greeted: true };
    });
    await chronos.start();

    const id = await trigger('greet', { payload: { name: 'Ada' }, idempotencyKey: 'greet-1' });
    const execution = await executionWhen(id, (status) => status === 'SUCCEEDED');
    expect(execution.result).toEqual({ greeted: true });
    expect(execution.attempts).toHaveLength(1);
    expect(execution.attempts[0]?.status).toBe('SUCCEEDED');
    expect(seen).toEqual([{ payload: { name: 'Ada' }, attempt: 1, key: 'manual:greet-1' }]);
    const logs = await waitFor(() => prisma.executionLog.findMany({ where: { executionId: id } }).then((rows) => (rows.length ? rows : null)));
    expect(logs[0]).toMatchObject({ level: 'INFO', message: 'hello from the handler', data: { n: 1 } });
  });

  it('retries failed attempts with backoff and records each attempt', async () => {
    let calls = 0;
    const chronos = agent();
    chronos.task('flaky', { maxAttempts: 3, retryBackoffMs: 0, retryBackoffMaxMs: 0 }, async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
      return 'ok';
    });
    await chronos.start();
    const id = await trigger('flaky');
    await executionWhen(id, (status) => status === 'RETRY_SCHEDULED');
    await cycle(); // re-dispatch the retry
    const execution = await executionWhen(id, (status) => status === 'SUCCEEDED');
    expect(execution.attempts.map((a) => a.status)).toEqual(['FAILED', 'SUCCEEDED']);
    expect(execution.attempts[0]?.errorMessage).toBe('transient');
  });

  it('does not retry NonRetryableError and dead-letters exhausted retries', async () => {
    const chronos = agent();
    chronos.task('permanent', { maxAttempts: 5 }, async () => {
      throw new NonRetryableError('bad input', 'BAD_INPUT');
    });
    chronos.task('always-fails', { maxAttempts: 1 }, async () => {
      throw new Error('nope');
    });
    await chronos.start();
    const permanent = await executionWhen(await trigger('permanent'), (status) => status === 'FAILED');
    expect(permanent.attempts).toHaveLength(1);
    expect(permanent.attempts[0]?.errorCode).toBe('BAD_INPUT');
    await executionWhen(await trigger('always-fails'), (status) => status === 'DEAD_LETTERED');
  });

  it('enforces handler timeouts', async () => {
    const chronos = agent();
    chronos.task('slow', { timeoutMs: 1000, maxAttempts: 1 }, (ctx) => new Promise((resolve) => ctx.signal.addEventListener('abort', resolve)));
    await chronos.start();
    const execution = await executionWhen(await trigger('slow'), (status) => status === 'DEAD_LETTERED');
    expect(execution.attempts[0]).toMatchObject({ status: 'TIMED_OUT', errorCode: 'TIMEOUT' });
  });

  it('rejects bad tokens and project mismatches without retrying', async () => {
    const badToken = agent({ token: 'chr_a_invalid-token-value' });
    badToken.task('t', async () => undefined);
    await expect(badToken.start()).rejects.toBeInstanceOf(ChronosConnectionError);
    expect(badToken.status).toBe('stopped');

    const wrongProject = agent({ project: 'someone-else' });
    wrongProject.task('t', async () => undefined);
    await expect(wrongProject.start()).rejects.toThrow(/belongs to project "storefront"/);
  });

  it('reconnects after the connection drops and keeps working', async () => {
    let connections = 0;
    const chronos = agent();
    chronos.on('connected', () => (connections += 1));
    chronos.task('after-reconnect', async () => 'done');
    await chronos.start();

    for (const session of (app.get(AgentGateway) as unknown as { sessions: Set<{ close(code: number, reason: string): void }> }).sessions) {
      session.close(1012, 'simulated restart');
    }
    await waitFor(() => connections >= 2, { message: 'reconnect' });
    expect(chronos.status).toBe('connected');
    await executionWhen(await trigger('after-reconnect'), (status) => status === 'SUCCEEDED');
  });

  it('delivers a result that completes while disconnected (lease renewed after reconnect)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let connections = 0;
    const chronos = agent();
    chronos.on('connected', () => (connections += 1));
    chronos.task('long', { timeoutMs: 60_000 }, async () => {
      await gate;
      return 'finished';
    });
    await chronos.start();
    const id = await trigger('long');
    await executionWhen(id, (status) => status === 'RUNNING');

    for (const session of (app.get(AgentGateway) as unknown as { sessions: Set<{ close(code: number, reason: string): void }> }).sessions) {
      session.close(1012, 'simulated network blip');
    }
    release();
    await waitFor(() => connections >= 2, { message: 'reconnect' });
    const execution = await executionWhen(id, (status) => status === 'SUCCEEDED');
    expect(execution.attempts).toHaveLength(1);
    expect(execution.result).toBe('finished');
  });

  it('propagates cancellation to the running handler', async () => {
    let aborted = false;
    const chronos = agent();
    chronos.task('cancellable', { timeoutMs: 60_000 }, (ctx) =>
      new Promise<void>((resolve) =>
        ctx.signal.addEventListener('abort', () => {
          aborted = true;
          resolve();
        }),
      ),
    );
    await chronos.start();
    const id = await trigger('cancellable');
    await executionWhen(id, (status) => status === 'RUNNING');
    await api(app).post(`/v1/projects/${boot.project.id}/executions/${id}/cancel`).set(...bearer(boot.credentials.userToken.token)).expect(200);
    await waitFor(() => aborted, { message: 'handler abort' });
    expect((await prisma.jobExecution.findUniqueOrThrow({ where: { id } })).status).toBe('CANCELLED');
  });

  it('shuts down gracefully, finishing running handlers first', async () => {
    const chronos = agent();
    chronos.task('finishing', async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return 'graceful';
    });
    await chronos.start();
    const id = await trigger('finishing');
    await executionWhen(id, (status) => status === 'RUNNING');
    await chronos.stop({ timeoutMs: 5000 });
    expect(chronos.status).toBe('stopped');
    expect((await prisma.jobExecution.findUniqueOrThrow({ where: { id } })).status).toBe('SUCCEEDED');
    await waitFor(async () => (await prisma.agent.findFirstOrThrow()).status === 'OFFLINE', { message: 'agent offline' });
  });

  it('recovers executions of an agent that vanished (lease expiry -> retry on another agent)', async () => {
    const crashing = agent();
    crashing.task('handoff', { maxAttempts: 3, retryBackoffMs: 0, retryBackoffMaxMs: 0, timeoutMs: 60_000 }, () => new Promise(() => undefined));
    await crashing.start();
    const id = await trigger('handoff');
    await executionWhen(id, (status) => status === 'RUNNING');
    // Simulate a crash: kill the socket without goodbye and never reconnect.
    (crashing as unknown as { state: string }).state = 'stopped';
    (crashing as unknown as { socket?: { terminate(): void } }).socket?.terminate();

    const healthy = agent();
    healthy.task('handoff', { maxAttempts: 3, retryBackoffMs: 0, retryBackoffMaxMs: 0, timeoutMs: 60_000 }, async () => 'recovered');
    await healthy.start();

    // Lease is 5s in this suite; the reaper turns the expired attempt into a retry.
    await waitFor(
      async () => {
        await cycle();
        return (await prisma.jobExecution.findUniqueOrThrow({ where: { id } })).status === 'SUCCEEDED';
      },
      { timeoutMs: 20_000, intervalMs: 500, message: 'recovery' },
    );
    const attempts = await prisma.jobAttempt.findMany({ where: { executionId: id }, orderBy: { attemptNumber: 'asc' } });
    expect(attempts.map((a) => [a.status, a.errorCode])).toEqual([
      ['ABANDONED', 'LEASE_EXPIRED'],
      ['SUCCEEDED', null],
    ]);
  });
});
