# @chronos/sdk

Node.js client for [Chronos](https://github.com/mdsharifulislam-r/cronous), a self-hosted
distributed job scheduler.

* **Workers:** run job handlers inside your application. Chronos tells them when to run,
  whether on a cron schedule, at a set time, immediately or after a delay.
* **Producers:** submit jobs for immediate or delayed execution from any service.
* **Admin:** manage jobs, schedules, queues and executions from code, and follow results.

```bash
npm install @chronos/sdk
```

Requires Node.js 20.11 or later and a running Chronos server. You can start one with Docker; see the
[quick start](https://github.com/mdsharifulislam-r/cronous#quick-start-docker-bundled-postgresql--redis).
The package ships CommonJS, ES modules and TypeScript types.

## Credentials

Create credentials in the dashboard (**Settings → Credentials**) or through the API:

| Token | Prefix | Use it for |
| --- | --- | --- |
| Agent token | `chr_a_` | `Chronos`: run handlers, submit and cancel jobs |
| Project API key | `chr_p_` | `ChronosAdmin`: manage jobs, queues, executions; submit jobs |
| User session | `chr_u_` | `ChronosAdmin` with full rights of that user (for example, creating queues) |

Keep tokens in environment variables. `Chronos` reads `CHRONOS_AGENT_TOKEN`, and
`ChronosAdmin` reads `CHRONOS_API_KEY`.

## Worker: run handlers in your application

```ts
import { Chronos, NonRetryableError } from '@chronos/sdk';

const chronos = new Chronos({
  server: 'https://chronos.example.com',
  project: 'storefront',
  timezone: 'Asia/Dhaka',
  concurrency: 10,
  // token: defaults to process.env.CHRONOS_AGENT_TOKEN
});

// A scheduled job: Chronos decides when it runs.
chronos.task('daily-report', { schedule: '0 2 * * *' }, async (ctx) => {
  ctx.log.info('Generating report', { scheduledFor: ctx.scheduledFor });
  await buildReport({ signal: ctx.signal });
});

// An on-demand job: runs when something submits it.
chronos.task('send-email', { queue: 'emails', maxAttempts: 5 }, async ({ payload, idempotencyKey }) => {
  if (!payload.to) throw new NonRetryableError('missing recipient'); // no retry
  await mailer.send(payload, { idempotencyKey });
  return { sent: true }; // stored as the execution result
});

await chronos.start();                       // connects and receives work
process.once('SIGTERM', () => chronos.stop()); // finishes running handlers first
```

The connection is outbound only (WebSocket), so your app needs no public port. It reconnects
automatically. Delivery is **at least once**: make handlers idempotent with
`ctx.idempotencyKey`.

Task options: `schedule` (5-field cron) or `runAt`, `timezone`, `misfirePolicy`
(`FIRE_ONCE` | `SKIP` | `FIRE_ALL`), `misfireGraceMs`, `maxCatchUp`, `timeoutMs`,
`maxAttempts`, `retryBackoffMs`, `retryBackoffMaxMs`, `concurrencyPolicy` (`ALLOW` | `FORBID`),
`queue`, `priority` (0-100), `maxConcurrency` and `payloadSchema` (JSON Schema).

The handler context provides `executionId`, `attempt`, `task`, `scheduledFor`, `idempotencyKey`,
`payload`, `signal` (aborted on timeout, cancellation or shutdown) and `log`.

Events: `connected`, `disconnected`, `error`, `drained` (all results acknowledged) and `stopped`.

## Producer: submit jobs

Submitting needs no `start()`, only the server URL and a token.

```ts
await chronos.queue('send-email', { to: 'a@example.com' });                     // now
await chronos.queue('send-reminder', { userId: 7 }, { delay: 5 * 60_000 });     // in 5 minutes
await chronos.queue('close-trial', { userId: 7 }, { runAt: '2026-12-01T09:00:00Z', priority: 80 });

const { id } = await chronos.queue('charge', { invoice: 9 }, { idempotencyKey: 'invoice-9' });
await chronos.cancel(id); // true if it had not started yet
```

Options: `delay` (ms) or `runAt`, `priority`, `queue`, `idempotencyKey`, `maxAttempts`,
`backoff: { delay, maxDelay }`, `timeoutMs`. A job can be handled by an SDK worker, a
Chronos central worker or an HTTP webhook. The producer does not need to know which.

## Admin: manage Chronos from code

```ts
import { ChronosAdmin } from '@chronos/sdk';

const admin = new ChronosAdmin({
  server: 'https://chronos.example.com',
  project: 'storefront',
  // token: defaults to process.env.CHRONOS_API_KEY (chr_p_...)
});
// or, from an existing worker: const admin = chronos.admin({ token: process.env.CHRONOS_API_KEY });
```

Jobs are addressed by **name** or id.

```ts
// Jobs
await admin.jobs.create({
  name: 'sync-crm',
  mode: 'HTTP',
  http: { url: 'https://app.example.com/hooks/sync', method: 'POST', signingSecret: process.env.HOOK_SECRET },
  schedule: { cron: '*/15 * * * *', timezone: 'UTC' },
  maxAttempts: 5,
});
await admin.jobs.list({ mode: 'AGENT', enabled: true });
await admin.jobs.update('sync-crm', { timeoutMs: 60_000 });
await admin.jobs.pause('sync-crm');            // pause the schedule
await admin.jobs.resume('sync-crm');
await admin.jobs.disable('sync-crm');          // nothing runs, not even manual triggers
await admin.jobs.nextRuns('sync-crm', 5);      // upcoming run times
await admin.jobs.delete('sync-crm');

// Run now and wait for the result
const run = await admin.jobs.trigger('daily-report', { payload: { day: '2026-11-26' } });
const done = await admin.executions.wait(run.id, { timeoutMs: 120_000 });
console.log(done.status, done.result);

// Executions
const page = await admin.executions.list({ job: 'send-email', status: ['FAILED', 'DEAD_LETTERED'], limit: 50 });
for await (const execution of admin.executions.iterate({ status: 'DEAD_LETTERED' })) {
  await admin.executions.retry(execution.id);   // replay
}
await admin.executions.get(id);                 // attempts, result, first 500 log lines
await admin.executions.logs(id, { afterId });   // follow logs
await admin.executions.cancel(id);

// Submissions
await admin.queue('send-email', { to: 'a@example.com' }, { delay: 60_000 });
await admin.queueBatch([{ job: 'send-email', payload: { to: 'a' } }, { job: 'send-email', payload: { to: 'b' } }]);

// Queues (create, update and delete need an ADMIN user's token)
await admin.queues.list();                      // with waiting, delayed, running counts
await admin.queues.pause('emails');
await admin.queues.resume('emails');
await admin.queues.create({ name: 'reports', concurrencyLimit: 2 });

// Schedules, agents, statistics
await admin.schedules.preview({ cron: '0 9 * * 1-5', timezone: 'Asia/Dhaka' }, 5);
await admin.schedules.upcoming({ to: new Date(Date.now() + 86_400_000) });
await admin.agents.list({ status: 'ONLINE' });
await admin.stats.summary({ hours: 24 });
await admin.stats.timeseries({ hours: 168, bucket: 'day' });
```

Responses are the API's JSON objects with typed fields. Timestamps are ISO 8601 strings.

## Errors

All request failures are `ChronosRequestError` subclasses with `status`, `code` and `details`:

| Class | When |
| --- | --- |
| `ChronosValidationError` | 400: invalid input, payload fails the job's schema |
| `ChronosAuthError` | 401/403: bad or revoked token, or a token without the required rights |
| `ChronosNotFoundError` | 404: unknown job, queue or execution |
| `ChronosConflictError` | 409: name exists, job disabled, execution already finished |
| `ChronosRequestError` | anything else, including network errors (`status` 0) |

Others: `ChronosConfigError` (bad options), `ChronosConnectionError` (fatal worker connection
error, such as a revoked token), `ChronosWaitTimeoutError` (`executions.wait()` timed out) and
`NonRetryableError` (throw it from a handler).

Rate limits (429) and temporary unavailability (503) are retried automatically. Reads and
submissions are also retried after network errors, and submissions keep their idempotency
key so they are never duplicated.

## License

Apache-2.0
