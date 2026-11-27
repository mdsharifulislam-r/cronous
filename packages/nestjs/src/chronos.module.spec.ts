import 'reflect-metadata';
import { Chronos, ChronosAdmin, type TaskContext, type TaskHandler, type TaskOptions } from '@cronous/cronous';
import { Injectable, Module, Scope } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChronosExplorer } from './chronos.explorer';
import { ChronosModule } from './chronos.module';
import { Ctx, Payload, Task, TaskReg } from './decorators';

const base = { server: 'http://localhost:8080', project: 'shop', token: 'chr_a_test', logger: false as const };

let registered: Map<string, { options: TaskOptions; handler: TaskHandler }>;
let start: { mockRejectedValue(error: Error): unknown } & ReturnType<typeof vi.fn>;
let stop: ReturnType<typeof vi.fn>;

beforeEach(() => {
  registered = new Map();
  vi.spyOn(Chronos.prototype, 'task').mockImplementation(function (this: Chronos, name: string, options: unknown, handler?: unknown) {
    registered.set(name, { options: options as TaskOptions, handler: handler as TaskHandler });
    return this;
  } as Chronos['task']);
  start = vi.spyOn(Chronos.prototype, 'start').mockResolvedValue() as unknown as typeof start;
  stop = vi.spyOn(Chronos.prototype, 'stop').mockResolvedValue() as unknown as typeof stop;
});

afterEach(() => vi.restoreAllMocks());

function context(payload: unknown): TaskContext {
  return { executionId: 'exe_1', attempt: 1, task: 'x', payload, idempotencyKey: 'idem_1' } as unknown as TaskContext;
}

@Injectable()
class Mailer {
  readonly sent: string[] = [];
  send(to: string) {
    this.sent.push(to);
    return { sent: true, to };
  }
}

@Injectable()
class EmailJobs {
  constructor(private readonly mailer: Mailer) {}

  @Task('email.send', { queue: 'emails', maxAttempts: 5 })
  send(@Payload() payload: { to: string }, @Ctx() ctx: TaskContext) {
    return { ...this.mailer.send(payload.to), key: ctx.idempotencyKey };
  }

  @Task({ name: 'email.digest', schedule: '0 8 * * *', timezone: 'UTC' })
  digest(ctx: TaskContext) {
    return { execution: ctx.executionId };
  }

  @TaskReg('email.bounce')
  bounce(@Payload('address') address: string) {
    return { address };
  }

  notATask() {
    return 'ignored';
  }
}

describe('ChronosModule', () => {
  it('registers @Task() methods with their options and starts the agent', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ChronosModule.forRoot(base)], providers: [Mailer, EmailJobs] }).compile();
    await moduleRef.init();

    expect([...registered.keys()].sort()).toEqual(['email.bounce', 'email.digest', 'email.send']);
    expect(registered.get('email.send')!.options).toEqual({ queue: 'emails', maxAttempts: 5 });
    expect(registered.get('email.digest')!.options).toEqual({ schedule: '0 8 * * *', timezone: 'UTC' });
    expect(start).toHaveBeenCalledTimes(1);
    expect(moduleRef.get(ChronosExplorer).tasks.map((task) => task.methodName).sort()).toEqual(['bounce', 'digest', 'send']);

    await moduleRef.close();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('maps @Payload(), @Payload(field) and @Ctx(), and keeps the provider instance as this', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ChronosModule.forRoot(base)], providers: [Mailer, EmailJobs] }).compile();
    await moduleRef.init();

    expect(await registered.get('email.send')!.handler(context({ to: 'a@example.com' }))).toEqual({ sent: true, to: 'a@example.com', key: 'idem_1' });
    expect(moduleRef.get(Mailer).sent).toEqual(['a@example.com']);
    expect(await registered.get('email.bounce')!.handler(context({ address: 'b@example.com' }))).toEqual({ address: 'b@example.com' });
    // No parameter decorators: the method receives the TaskContext.
    expect(await registered.get('email.digest')!.handler(context(null))).toEqual({ execution: 'exe_1' });
    await moduleRef.close();
  });

  it('does not register or connect with worker: false', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ChronosModule.forRoot({ ...base, worker: false })], providers: [Mailer, EmailJobs] }).compile();
    await moduleRef.init();
    expect(registered.size).toBe(0);
    expect(start).not.toHaveBeenCalled();
    await moduleRef.close();
    expect(stop).not.toHaveBeenCalled();
  });

  it('does not connect when the application has no tasks (producer only)', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ChronosModule.forRoot(base)], providers: [Mailer] }).compile();
    await moduleRef.init();
    expect(start).not.toHaveBeenCalled();
    await moduleRef.close();
  });

  it('forRootAsync resolves options from injected providers and exposes Chronos and ChronosAdmin', async () => {
    @Injectable()
    class Config {
      get(key: string) {
        return ({ server: 'http://chronos:8080', project: 'billing' } as Record<string, string>)[key];
      }
    }
    @Module({ providers: [Config], exports: [Config] })
    class ConfigModule {}

    @Injectable()
    class Producer {
      constructor(
        readonly chronos: Chronos,
        readonly admin: ChronosAdmin,
      ) {}
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        ChronosModule.forRootAsync({
          imports: [ConfigModule],
          inject: [Config],
          useFactory: (config: Config) => ({ server: config.get('server')!, project: config.get('project')!, logger: false, apiKey: 'chr_p_test' }),
        }),
      ],
      providers: [Producer],
    }).compile();
    await moduleRef.init();

    const producer = moduleRef.get(Producer);
    expect(producer.chronos).toBeInstanceOf(Chronos);
    expect(producer.admin).toBeInstanceOf(ChronosAdmin);
    expect(producer.chronos).toBe(moduleRef.get(Chronos));
    await moduleRef.close();
  });

  it('forRootAsync supports useClass', async () => {
    @Injectable()
    class ChronosConfig {
      createChronosOptions() {
        return { ...base, worker: false };
      }
    }
    const moduleRef = await Test.createTestingModule({ imports: [ChronosModule.forRootAsync({ useClass: ChronosConfig })] }).compile();
    await moduleRef.init();
    expect(moduleRef.get(Chronos)).toBeInstanceOf(Chronos);
    await moduleRef.close();
  });

  it('rejects @Task() handlers in request-scoped providers', async () => {
    @Injectable({ scope: Scope.REQUEST })
    class ScopedJobs {
      @Task('scoped.job')
      run() {
        return null;
      }
    }
    const moduleRef = await Test.createTestingModule({ imports: [ChronosModule.forRoot(base)], providers: [ScopedJobs] }).compile();
    await expect(moduleRef.init()).rejects.toThrow(/ScopedJobs has @Task\(\) handlers but is request- or transient-scoped/);
  });

  it('can start without blocking bootstrap', async () => {
    start.mockRejectedValue(new Error('connection refused'));
    const moduleRef = await Test.createTestingModule({ imports: [ChronosModule.forRoot({ ...base, waitForConnection: false })], providers: [Mailer, EmailJobs] }).compile();
    await expect(moduleRef.init()).resolves.toBeDefined();
    await moduleRef.close();
  });

  it('fails bootstrap when the agent cannot start (default)', async () => {
    start.mockRejectedValue(new Error('invalid token'));
    const moduleRef = await Test.createTestingModule({ imports: [ChronosModule.forRoot(base)], providers: [Mailer, EmailJobs] }).compile();
    await expect(moduleRef.init()).rejects.toThrow('invalid token');
  });
});

describe('@Task()', () => {
  it('requires a name', () => {
    expect(() => Task('')).toThrow('@Task() needs a task name');
  });
});
