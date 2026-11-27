# @cronous/nestjs

NestJS integration for [Chronos](https://github.com/mdsharifulislam-r/cronous), a self-hosted
job scheduler. Register the module once, write handlers as decorated methods, and inject the
Chronos client anywhere to submit and manage jobs.

```bash
npm install @cronous/nestjs @cronous/cronous
```

Requires Node.js 20.11+ and NestJS 10 or 11. You need a running Chronos server
(`docker pull cronouss/cronous`, see the [main README](https://github.com/mdsharifulislam-r/cronous#readme)).

## 1. Register the module

```ts
import { Module } from '@nestjs/common';
import { ChronosModule } from '@cronous/nestjs';

@Module({
  imports: [
    ChronosModule.forRoot({
      server: 'http://localhost:8080',
      project: 'shop',
      token: process.env.CHRONOS_AGENT_TOKEN, // chr_a_…  runs the handlers
      apiKey: process.env.CHRONOS_API_KEY,    // chr_p_…  for ChronosAdmin (optional)
      concurrency: 5,
    }),
  ],
})
export class AppModule {}
```

With `@nestjs/config`:

```ts
ChronosModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    server: config.getOrThrow('CHRONOS_SERVER'),
    project: config.getOrThrow('CHRONOS_PROJECT'),
    token: config.get('CHRONOS_AGENT_TOKEN'),
    apiKey: config.get('CHRONOS_API_KEY'),
  }),
});
```

`useClass` and `useExisting` (a class with `createChronosOptions()`) work too. The module is
global by default; pass `isGlobal: false` to change that.

## 2. Write handlers with `@Task()`

Any provider (or controller) can hold handlers. They are found when the application starts,
registered with Chronos, and run inside your Nest process with full dependency injection.

```ts
import { Injectable } from '@nestjs/common';
import { Ctx, NonRetryableError, Payload, Task, type TaskContext } from '@cronous/nestjs';

@Injectable()
export class EmailJobs {
  constructor(private readonly mailer: MailerService) {}

  @Task('email.send', { queue: 'emails', maxAttempts: 5, timeoutMs: 30_000 })
  async send(@Payload() email: { to: string; subject: string }, @Ctx() ctx: TaskContext) {
    ctx.log.info('sending', { to: email.to, attempt: ctx.attempt });
    await this.mailer.send(email, { idempotencyKey: ctx.idempotencyKey });
    return { sent: true };
  }

  @Task({ name: 'report.daily', schedule: '0 2 * * *', timezone: 'Europe/Berlin' })
  async dailyReport(ctx: TaskContext) {
    // No parameter decorators: the method receives the TaskContext.
    return { generatedAt: new Date().toISOString() };
  }

  @Task('order.validate')
  validate(@Payload('amount') amount: number) {
    if (amount <= 0) throw new NonRetryableError('invalid amount'); // fails without retries
    return { ok: true };
  }
}
```

| Decorator | Purpose |
| --- | --- |
| `@Task(name, options?)` or `@Task({ name, ...options })` | Registers the method as the handler of task `name`. `TaskReg` is an alias. |
| `@Payload()` | The execution payload |
| `@Payload('field')` | One property of the payload |
| `@Ctx()` | The `TaskContext`: `executionId`, `attempt`, `idempotencyKey`, `scheduledFor`, `signal`, `log` |

`@Task()` accepts every option of `chronos.task()`: `schedule`, `runAt`, `timezone`,
`misfirePolicy`, `timeoutMs`, `maxAttempts`, `retryBackoffMs`, `retryBackoffMaxMs`,
`concurrencyPolicy`, `queue`, `priority`, `maxConcurrency`, `payloadSchema`, `description`.

Rules:

* Handlers must live in **singleton** providers. Request- or transient-scoped classes with
  `@Task()` fail at startup.
* Delivery is at least once. Make side effects idempotent with `ctx.idempotencyKey`.
* Long handlers should watch `ctx.signal` (aborted on timeout, cancel or shutdown).

## 3. Submit and manage jobs

`Chronos` and `ChronosAdmin` are injectable:

```ts
import { Injectable } from '@nestjs/common';
import { Chronos, ChronosAdmin } from '@cronous/nestjs';

@Injectable()
export class OrdersService {
  constructor(
    private readonly chronos: Chronos,
    private readonly admin: ChronosAdmin,
  ) {}

  async placeOrder(order: Order) {
    await this.chronos.queue('email.send', { to: order.email, subject: 'Thanks!' });
    await this.chronos.queue('email.send', { to: order.email, subject: 'How was it?' }, { delay: 3 * 24 * 3600_000 });
  }

  failed() {
    return this.admin.executions.list({ status: 'FAILED', limit: 20 });
  }
}
```

The admin client covers jobs, queues, executions, schedules, agents and stats. See the
[`@cronous/cronous` README](https://www.npmjs.com/package/@cronous/cronous) for every method.
All exports of `@cronous/cronous` (clients, errors, types) are re-exported from
`@cronous/nestjs`.

## 4. Startup and shutdown

* On bootstrap the module registers all `@Task()` methods and connects to Chronos over an
  outbound WebSocket. No public port is needed.
* An application without `@Task()` methods never opens that connection and needs no agent
  token, so API-only services can just submit jobs.
* On shutdown, running handlers finish (up to `shutdownTimeoutMs`) before the process exits.
  Enable Nest's shutdown hooks so SIGTERM triggers this:

```ts
const app = await NestFactory.create(AppModule);
app.enableShutdownHooks();
await app.listen(3000);
```

## Options

All `Chronos` client options (`server`, `project`, `token`, `timezone`, `concurrency`,
`instanceId`, `hostname`, `reconnect`, `shutdownTimeoutMs`), plus:

| Option | Default | Description |
| --- | --- | --- |
| `apiKey` | `CHRONOS_API_KEY` | Project API key for `ChronosAdmin` |
| `admin` | | `{ maxAttempts, requestTimeoutMs }` for `ChronosAdmin` |
| `worker` | `true` | `false` skips handler registration and the agent connection (e.g. API-only replicas) |
| `waitForConnection` | `true` | Bootstrap waits for the agent handshake, so a bad token fails startup. `false` connects in the background and logs errors. |
| `logger` | Nest `Logger('Chronos')` | A custom `ChronosLogger`, or `false` to silence the SDK |
| `isGlobal` | `true` | Register the module globally |

`token` defaults to `CHRONOS_AGENT_TOKEN`.

## License

Apache-2.0
