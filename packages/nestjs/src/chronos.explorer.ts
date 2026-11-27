import { Chronos, type TaskContext, type TaskOptions } from '@cronous/cronous';
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import type { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper';
import { CHRONOS_MODULE_OPTIONS, CHRONOS_TASK_METADATA, CHRONOS_TASK_PARAMS_METADATA } from './constants';
import type { TaskParamMetadata } from './decorators';
import type { ChronosModuleOptions, TaskMetadata } from './interfaces';

export interface DiscoveredTask {
  name: string;
  className: string;
  methodName: string;
}

type AnyPrototype = Record<string, unknown>;

/**
 * Finds every @Task() method in the application's providers and controllers, registers
 * them with the Chronos client, starts the agent on bootstrap and stops it gracefully
 * on shutdown (call app.enableShutdownHooks() so SIGTERM triggers it).
 */
@Injectable()
export class ChronosExplorer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Chronos');
  private readonly discovered: DiscoveredTask[] = [];
  private started = false;

  constructor(
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    @Inject(MetadataScanner) private readonly scanner: MetadataScanner,
    @Inject(Chronos) private readonly chronos: Chronos,
    @Inject(CHRONOS_MODULE_OPTIONS) private readonly options: ChronosModuleOptions,
  ) {}

  /** Tasks registered from decorators (after bootstrap). */
  get tasks(): readonly DiscoveredTask[] {
    return this.discovered;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.options.worker === false) return;
    this.registerTasks();
    if (this.discovered.length === 0) return; // producer/admin-only application: no agent connection needed

    this.started = true;
    const starting = this.chronos.start();
    if (this.options.waitForConnection === false) {
      starting.catch((error: Error) => this.logger.error(`Chronos agent could not start: ${error.message}`));
      return;
    }
    await starting;
    this.logger.log(`Agent connected with ${this.discovered.length} task(s): ${this.discovered.map((task) => task.name).join(', ')}`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.started) await this.chronos.stop();
  }

  private registerTasks(): void {
    const seen = new Set<object>();
    const wrappers: InstanceWrapper[] = [...this.discovery.getProviders(), ...this.discovery.getControllers()];
    for (const wrapper of wrappers) {
      const prototype = prototypeOf(wrapper);
      if (!prototype) continue;
      const methods = this.scanner
        .getAllMethodNames(prototype)
        .map((methodName) => ({ methodName, metadata: Reflect.getMetadata(CHRONOS_TASK_METADATA, prototype[methodName] as object) as TaskMetadata | undefined }))
        .filter((entry): entry is { methodName: string; metadata: TaskMetadata } => entry.metadata !== undefined);
      if (methods.length === 0) continue;

      const className: string = (prototype.constructor as { name?: string } | undefined)?.name ?? String(wrapper.token);
      const instance = wrapper.instance as Record<string, (...args: unknown[]) => unknown> | undefined;
      if (!wrapper.isDependencyTreeStatic() || !instance) {
        throw new Error(`${className} has @Task() handlers but is request- or transient-scoped; task handlers must live in singleton providers`);
      }
      if (seen.has(instance)) continue; // the same instance exposed under several tokens
      seen.add(instance);

      for (const { methodName, metadata } of methods) {
        const { name, ...taskOptions } = metadata;
        const params = Reflect.getMetadata(CHRONOS_TASK_PARAMS_METADATA, prototype, methodName) as TaskParamMetadata[] | undefined;
        const handler = (context: TaskContext) => instance[methodName]!(...handlerArgs(params, context));
        this.chronos.task(name, taskOptions as TaskOptions, handler);
        this.discovered.push({ name, className, methodName });
      }
    }
  }
}

function prototypeOf(wrapper: InstanceWrapper): AnyPrototype | undefined {
  const { instance, metatype } = wrapper;
  if (wrapper.isDependencyTreeStatic()) {
    return instance !== null && typeof instance === 'object' ? (Object.getPrototypeOf(instance) as AnyPrototype) : undefined;
  }
  // Request/transient providers have no shared instance; inspect the class to report misuse.
  return typeof metatype === 'function' && metatype.prototype ? (metatype.prototype as AnyPrototype) : undefined;
}

function handlerArgs(params: TaskParamMetadata[] | undefined, context: TaskContext): unknown[] {
  if (!params || params.length === 0) return [context];
  const args: unknown[] = [];
  for (const param of params) {
    if (param.type === 'context') {
      args[param.index] = context;
    } else {
      const payload = context.payload as Record<string, unknown> | null | undefined;
      args[param.index] = param.property === undefined ? payload : payload?.[param.property];
    }
  }
  return args;
}
