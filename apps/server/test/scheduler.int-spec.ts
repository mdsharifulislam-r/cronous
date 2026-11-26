import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dispatcher, ExecutionQueues, SchedulerEngine, bullJobId, syncAgentTasks } from '@chronos/engine';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { BootstrapService } from '../src/modules/bootstrap/bootstrap.service';
import { BootstrapResult, api, bearer, bootstrapInstallation, resetState, startTestApp } from './setup/test-app';

const HOUR = 3600_000;

describe('scheduling engine (PostgreSQL)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let boot: BootstrapResult;
  let token: string;

  beforeAll(async () => {
    app = await startTestApp();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await resetState(app);
    await app.get(BootstrapService).ensureBootstrapToken();
    boot = await bootstrapInstallation(app);
    token = boot.credentials.userToken.token;
  });

  afterAll(async () => {
    await app.close();
  });

  const jobsPath = () => `/v1/projects/${boot.project.id}/jobs`;

  async function createJob(body: Record<string, unknown>) {
    const response = await api(app).post(jobsPath()).set(...bearer(token)).send({ mode: 'WORKER', ...body });
    if (response.status !== 201) throw new Error(`create job failed: ${response.status} ${JSON.stringify(response.body)}`);
    return response.body.data as { id: string; name: string; schedule: { nextRunAt: string; state: string } | null };
  }

  /** Moves a schedule's next occurrence into the past, as if the scheduler had been down. */
  async function makeDue(jobId: string, nextRunAt: Date) {
    await prisma.jobSchedule.update({ where: { jobId }, data: { nextRunAt } });
  }

  const engine = () => new SchedulerEngine(prisma, { batchSize: 7 });

  describe('job API', () => {
    it('creates a cron job with a timezone-aware next run', async () => {
      const job = await createJob({ name: 'daily-report', schedule: { cron: '0 2 * * *', timezone: 'Asia/Dhaka' } });
      const next = new Date(job.schedule!.nextRunAt);
      // 02:00 in Dhaka is 20:00 UTC.
      expect(next.getUTCHours()).toBe(20);
      expect(next.getUTCMinutes()).toBe(0);
      expect(next.getTime()).toBeGreaterThan(Date.now());

      const preview = await api(app).get(`${jobsPath()}/${job.id}/schedule/preview?count=3`).set(...bearer(token)).expect(200);
      expect(preview.body.data.occurrences).toHaveLength(3);
    });

    it('defaults the schedule time zone to the project time zone', async () => {
      const job = await createJob({ name: 'tz-default', schedule: { cron: '0 2 * * *' } });
      const stored = await prisma.jobSchedule.findUniqueOrThrow({ where: { jobId: job.id } });
      expect(stored.timezone).toBe('Asia/Dhaka');
    });

    it('validates definitions', async () => {
      const bad = [
        { name: 'x', mode: 'HTTP' },
        { name: 'x', schedule: { cron: '* * *' } },
        { name: 'x', schedule: { cron: '0 2 * * *', timezone: 'Nowhere/Land' } },
        { name: 'bad name!' },
        { name: 'x', mode: 'HTTP', http: { url: 'ftp://example.com' } },
        { name: 'x', mode: 'HTTP', http: { url: 'https://user:pw@example.com' } },
      ];
      for (const body of bad) {
        const response = await api(app).post(jobsPath()).set(...bearer(token)).send({ mode: 'WORKER', ...body });
        expect(response.status, JSON.stringify(body)).toBe(400);
      }
      await createJob({ name: 'dup' });
      await api(app).post(jobsPath()).set(...bearer(token)).send({ name: 'dup', mode: 'WORKER' }).expect(409);
    });

    it('masks webhook secrets in responses', async () => {
      const response = await api(app)
        .post(jobsPath())
        .set(...bearer(token))
        .send({
          name: 'hook',
          mode: 'HTTP',
          http: { url: 'https://example.com/hook', headers: { 'X-Api-Key': 'super-secret', 'X-Trace': 'visible' }, auth: { type: 'bearer', token: 'tok-secret' } },
        })
        .expect(201);
      const text = JSON.stringify(response.body);
      expect(text).not.toContain('super-secret');
      expect(text).not.toContain('tok-secret');
      expect(response.body.data.http.headers['X-Trace']).toBe('visible');
    });

    it('lets project API keys manage jobs', async () => {
      const key = boot.credentials.projectKey.token;
      await api(app).post(jobsPath()).set(...bearer(key)).send({ name: 'from-key', mode: 'WORKER' }).expect(201);
      await api(app).get(jobsPath()).set(...bearer(key)).expect(200);
    });

    it('protects SDK-defined jobs from API edits except enable/disable', async () => {
      const [task] = await prisma.$transaction((tx) =>
        syncAgentTasks(tx, boot.project.id, 'UTC', [
          { name: 'sdk-task', timeoutMs: 1000, maxAttempts: 1, retryBackoffMs: 0, retryBackoffMaxMs: 0, concurrencyPolicy: 'ALLOW', schedule: null },
        ], new Date()),
      );
      await api(app).patch(`${jobsPath()}/${task!.jobId}`).set(...bearer(token)).send({ maxAttempts: 5 }).expect(409);
      await api(app).patch(`${jobsPath()}/${task!.jobId}`).set(...bearer(token)).send({ enabled: false }).expect(200);
    });
  });

  describe('due-job detection and duplicate prevention', () => {
    it('dispatches each occurrence exactly once across concurrent scheduler replicas', async () => {
      const jobs = await Promise.all(Array.from({ length: 25 }, (_, i) => createJob({ name: `job-${i}`, schedule: { cron: '0 * * * *', timezone: 'UTC' } })));
      const occurrence = new Date(Math.floor(Date.now() / HOUR) * HOUR); // the current hour, already passed
      await Promise.all(jobs.map((job) => makeDue(job.id, occurrence)));

      // Five replicas tick concurrently, twice.
      const replicas = Array.from({ length: 5 }, engine);
      for (let round = 0; round < 2; round += 1) {
        await Promise.all(replicas.map((replica) => replica.tickUntilDrained()));
      }

      const executions = await prisma.jobExecution.findMany({ select: { jobId: true, idempotencyKey: true } });
      expect(executions).toHaveLength(25);
      expect(new Set(executions.map((e) => e.jobId)).size).toBe(25);
      expect(new Set(executions.map((e) => e.idempotencyKey))).toEqual(new Set([`sched:${occurrence.toISOString()}`]));

      const schedules = await prisma.jobSchedule.findMany();
      expect(schedules.every((s) => s.nextRunAt!.getTime() === occurrence.getTime() + HOUR)).toBe(true);
    });

    it('never creates a second execution for an occurrence, even when re-presented as due', async () => {
      const job = await createJob({ name: 'replay-guard', schedule: { cron: '0 * * * *', timezone: 'UTC' } });
      const occurrence = new Date(Math.floor(Date.now() / HOUR) * HOUR);
      await makeDue(job.id, occurrence);
      expect((await engine().tick()).executionsCreated).toBe(1);
      // A stale replica (or a restored backup) presents the same occurrence again.
      await makeDue(job.id, occurrence);
      const second = await engine().tick();
      expect(second.schedulesProcessed).toBe(1);
      expect(second.executionsCreated).toBe(0);
      expect(await prisma.jobExecution.count({ where: { jobId: job.id } })).toBe(1);
    });

    it('ignores disabled jobs, paused schedules and archived projects', async () => {
      const disabled = await createJob({ name: 'disabled', enabled: false, schedule: { cron: '0 * * * *', timezone: 'UTC' } });
      const paused = await createJob({ name: 'paused', schedule: { cron: '0 * * * *', timezone: 'UTC' } });
      const past = new Date(Math.floor(Date.now() / HOUR) * HOUR);
      await makeDue(disabled.id, past);
      await makeDue(paused.id, past);
      const pausedView = await api(app).post(`${jobsPath()}/${paused.id}/pause`).set(...bearer(token)).expect(200);
      expect(pausedView.body.data.schedule).toMatchObject({ state: 'PAUSED', nextRunAt: null });

      expect((await engine().tick()).executionsCreated).toBe(0);

      const resumed = await api(app).post(`${jobsPath()}/${paused.id}/resume`).set(...bearer(token)).expect(200);
      expect(new Date(resumed.body.data.schedule.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('completes one-time schedules', async () => {
      const job = await createJob({ name: 'once', schedule: { runAt: new Date(Date.now() - 1000).toISOString() } });
      expect((await engine().tick()).executionsCreated).toBe(1);
      const schedule = await prisma.jobSchedule.findUniqueOrThrow({ where: { jobId: job.id } });
      expect(schedule).toMatchObject({ state: 'COMPLETED', nextRunAt: null });
      expect((await engine().tick()).executionsCreated).toBe(0);
    });
  });

  describe('misfire policies', () => {
    const hourly = { cron: '0 * * * *', timezone: 'UTC' };
    // The scheduler was down for three hours: four occurrences are due.
    const outageStart = () => new Date(Math.floor(Date.now() / HOUR) * HOUR - 3 * HOUR);

    it('FIRE_ONCE runs a single catch-up', async () => {
      const job = await createJob({ name: 'fire-once', schedule: { ...hourly, misfirePolicy: 'FIRE_ONCE' } });
      await makeDue(job.id, outageStart());
      const result = await engine().tick();
      expect(result.executionsCreated).toBe(1);
      expect(result.occurrencesDropped).toBe(3);
    });

    it('FIRE_ALL replays missed occurrences up to maxCatchUp', async () => {
      const all = await createJob({ name: 'fire-all', schedule: { ...hourly, misfirePolicy: 'FIRE_ALL', maxCatchUp: 10 } });
      const capped = await createJob({ name: 'fire-all-capped', schedule: { ...hourly, misfirePolicy: 'FIRE_ALL', maxCatchUp: 2 } });
      await makeDue(all.id, outageStart());
      await makeDue(capped.id, outageStart());
      await engine().tick();
      expect(await prisma.jobExecution.count({ where: { jobId: all.id } })).toBe(4);
      expect(await prisma.jobExecution.count({ where: { jobId: capped.id } })).toBe(2);
    });

    it('SKIP drops late occurrences', async () => {
      const job = await createJob({ name: 'skip', schedule: { ...hourly, misfirePolicy: 'SKIP', misfireGraceMs: 0 } });
      await makeDue(job.id, outageStart());
      await engine().tick();
      expect(await prisma.jobExecution.count({ where: { jobId: job.id } })).toBe(0);
      const schedule = await prisma.jobSchedule.findUniqueOrThrow({ where: { jobId: job.id } });
      expect(schedule.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    });

    it('FORBID skips occurrences while an execution is still active', async () => {
      const job = await createJob({ name: 'forbid', concurrencyPolicy: 'FORBID', schedule: hourly });
      await api(app).post(`${jobsPath()}/${job.id}/trigger`).set(...bearer(token)).send({}).expect(201);
      await makeDue(job.id, outageStart());
      const result = await engine().tick();
      expect(result.skippedForOverlap).toBe(1);
      expect(await prisma.jobExecution.count({ where: { jobId: job.id } })).toBe(1);
      await api(app).post(`${jobsPath()}/${job.id}/trigger`).set(...bearer(token)).send({}).expect(409);
    });
  });

  describe('dispatch (transactional outbox)', () => {
    it('stamps manual triggers with the database clock, so app clock skew cannot delay them', async () => {
      const job = await createJob({ name: 'clock', mode: 'WORKER' });
      // Simulate a server whose clock runs an hour ahead of PostgreSQL (only Date is faked).
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 3600_000 });
      let executionId: string;
      try {
        const response = await api(app).post(`${jobsPath()}/${job.id}/trigger`).set(...bearer(token)).send({}).expect(201);
        executionId = response.body.data.execution.id as string;
      } finally {
        vi.useRealTimers();
      }
      const [row] = await prisma.$queryRaw<{ due: boolean }[]>`
        SELECT next_attempt_at <= now() AND scheduled_for <= now() AS due FROM job_executions WHERE id = ${executionId}::uuid`;
      expect(row).toEqual({ due: true });
      const dispatcher = new Dispatcher({ prisma, queues: app.get(ExecutionQueues), notifyAgents: vi.fn().mockResolvedValue(undefined) });
      expect(await dispatcher.dispatch()).toBe(1);
    });

    it('queues worker executions in BullMQ and wakes agents for agent executions', async () => {
      const worker = await createJob({ name: 'w', mode: 'WORKER' });
      const agent = await createJob({ name: 'a', mode: 'AGENT' });
      await api(app).post(`${jobsPath()}/${worker.id}/trigger`).set(...bearer(token)).send({}).expect(201);
      await api(app).post(`${jobsPath()}/${agent.id}/trigger`).set(...bearer(token)).send({}).expect(201);

      const queues = app.get(ExecutionQueues);
      const notifyAgents = vi.fn().mockResolvedValue(undefined);
      const dispatcher = new Dispatcher({ prisma, queues, notifyAgents });
      expect(await dispatcher.dispatch()).toBe(2);
      expect(await dispatcher.dispatch()).toBe(0);

      const workerExecution = await prisma.jobExecution.findFirstOrThrow({ where: { jobId: worker.id } });
      expect(workerExecution.status).toBe('QUEUED');
      const bullJob = await queues.queue('WORKER').getJob(bullJobId(workerExecution.id, 1));
      expect(bullJob?.data).toEqual({ executionId: workerExecution.id, attempt: 1 });
      expect(notifyAgents).toHaveBeenCalledWith([boot.project.id]);
    });

    it('re-enqueues a QUEUED execution whose delivery was lost', async () => {
      const job = await createJob({ name: 'lost' });
      await api(app).post(`${jobsPath()}/${job.id}/trigger`).set(...bearer(token)).send({}).expect(201);
      const queues = app.get(ExecutionQueues);
      const dispatcher = new Dispatcher({ prisma, queues, notifyAgents: async () => undefined }, { batchSize: 10, queuedStaleMs: 0 });
      await dispatcher.dispatch();
      const execution = await prisma.jobExecution.findFirstOrThrow({ where: { jobId: job.id } });
      // Simulate Redis losing the job.
      await (await queues.queue('WORKER').getJob(bullJobId(execution.id, 1)))!.remove();
      await prisma.$executeRaw`UPDATE job_executions SET updated_at = now() - interval '1 minute' WHERE id = ${execution.id}::uuid`;
      expect(await dispatcher.sweepStale()).toBe(1);
      expect(await queues.queue('WORKER').getJob(bullJobId(execution.id, 1))).toBeTruthy();
    });
  });

  describe('manual triggers and executions API', () => {
    it('is idempotent per idempotency key', async () => {
      const job = await createJob({ name: 'manual' });
      const first = await api(app).post(`${jobsPath()}/${job.id}/trigger`).set(...bearer(token)).send({ idempotencyKey: 'order-42', payload: { a: 1 } }).expect(201);
      const again = await api(app).post(`${jobsPath()}/${job.id}/trigger`).set(...bearer(token)).send({ idempotencyKey: 'order-42' }).expect(200);
      expect(again.body.data.execution.id).toBe(first.body.data.execution.id);
      expect(first.body.data.execution.payload).toEqual({ a: 1 });
      // Concurrent duplicates also collapse to one execution.
      const racing = await Promise.all(
        Array.from({ length: 5 }, () => api(app).post(`${jobsPath()}/${job.id}/trigger`).set(...bearer(token)).send({ idempotencyKey: 'race' })),
      );
      expect(new Set(racing.map((r) => r.body.data.execution.id)).size).toBe(1);
      expect(await prisma.jobExecution.count({ where: { jobId: job.id } })).toBe(2);
    });

    it('lists with filters and cursor pagination, and cancels/retries', async () => {
      const job = await createJob({ name: 'listing' });
      for (let i = 0; i < 5; i += 1) await api(app).post(`${jobsPath()}/${job.id}/trigger`).set(...bearer(token)).send({}).expect(201);
      const executionsPath = `/v1/projects/${boot.project.id}/executions`;

      const page1 = await api(app).get(`${executionsPath}?limit=2&jobId=${job.id}`).set(...bearer(token)).expect(200);
      expect(page1.body.data.items).toHaveLength(2);
      const page2 = await api(app).get(`${executionsPath}?limit=2&cursor=${page1.body.data.nextCursor}`).set(...bearer(token)).expect(200);
      const page3 = await api(app).get(`${executionsPath}?limit=2&cursor=${page2.body.data.nextCursor}`).set(...bearer(token)).expect(200);
      const ids = [...page1.body.data.items, ...page2.body.data.items, ...page3.body.data.items].map((e: { id: string }) => e.id);
      expect(new Set(ids).size).toBe(5);
      expect(page3.body.data.nextCursor).toBeNull();

      const target = ids[0];
      await api(app).post(`${executionsPath}/${target}/cancel`).set(...bearer(token)).expect(200);
      await api(app).post(`${executionsPath}/${target}/cancel`).set(...bearer(token)).expect(409);
      const cancelled = await api(app).get(`${executionsPath}?status=CANCELLED`).set(...bearer(token)).expect(200);
      expect(cancelled.body.data.items.map((e: { id: string }) => e.id)).toEqual([target]);

      await api(app).post(`${executionsPath}/${target}/retry`).set(...bearer(token)).expect(200);
      const detail = await api(app).get(`${executionsPath}/${target}`).set(...bearer(token)).expect(200);
      expect(detail.body.data.status).toBe('PENDING');
      expect(detail.body.data.jobName).toBe('listing');

      await api(app).get(`${executionsPath}?status=NOPE`).set(...bearer(token)).expect(400);
      const stats = await api(app).get(`/v1/projects/${boot.project.id}/stats`).set(...bearer(token)).expect(200);
      expect(stats.body.data.executions.PENDING).toBe(5);
    });
  });
});
