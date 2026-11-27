import type { TaskOptions } from '@cronous/cronous';
import { CHRONOS_TASK_METADATA, CHRONOS_TASK_PARAMS_METADATA } from './constants';
import type { TaskMetadata } from './interfaces';

/**
 * Registers the decorated method as the handler of a Chronos task. The class must be a
 * provider (or controller) of a module in the application. Handlers are registered and
 * the agent is started when the application bootstraps.
 *
 * Without parameter decorators the method receives the TaskContext (like chronos.task()).
 * Use @Payload() and @Ctx() to pick what each parameter receives.
 *
 * @example
 *   @Task('email.send', { queue: 'emails', maxAttempts: 5 })
 *   async send(@Payload() email: SendEmail, @Ctx() ctx: TaskContext) { ... }
 *
 * @example
 *   @Task({ name: 'report.daily', schedule: '0 2 * * *', timezone: 'Europe/Berlin' })
 *   async daily(ctx: TaskContext) { ... }
 */
export function Task(name: string, options?: TaskOptions): MethodDecorator;
export function Task(options: TaskMetadata): MethodDecorator;
export function Task(nameOrOptions: string | TaskMetadata, options: TaskOptions = {}): MethodDecorator {
  const metadata: TaskMetadata = typeof nameOrOptions === 'string' ? { ...options, name: nameOrOptions } : { ...nameOrOptions };
  if (typeof metadata.name !== 'string' || metadata.name.length === 0) {
    throw new Error('@Task() needs a task name');
  }
  return (target, propertyKey, descriptor) => {
    if (typeof descriptor.value !== 'function') {
      throw new Error(`@Task('${metadata.name}') must decorate a method (${String(propertyKey)})`);
    }
    Reflect.defineMetadata(CHRONOS_TASK_METADATA, metadata, descriptor.value);
    return descriptor;
  };
}

/** Alias of {@link Task}. */
export const TaskReg = Task;

export type TaskParamType = 'payload' | 'context';

export interface TaskParamMetadata {
  index: number;
  type: TaskParamType;
  /** For @Payload('field'): the payload property to inject. */
  property?: string;
}

function taskParam(type: TaskParamType, property?: string): ParameterDecorator {
  return (target, propertyKey, index) => {
    if (propertyKey === undefined) throw new Error(`@${type === 'payload' ? 'Payload' : 'Ctx'}() can only be used on task handler parameters`);
    const existing: TaskParamMetadata[] = Reflect.getMetadata(CHRONOS_TASK_PARAMS_METADATA, target, propertyKey) ?? [];
    Reflect.defineMetadata(CHRONOS_TASK_PARAMS_METADATA, [...existing, { index, type, ...(property !== undefined ? { property } : {}) }], target, propertyKey);
  };
}

/** Injects the execution payload, or one of its properties with @Payload('field'). */
export function Payload(property?: string): ParameterDecorator {
  return taskParam('payload', property);
}

/** Injects the TaskContext: executionId, attempt, idempotencyKey, signal, log, … */
export function Ctx(): ParameterDecorator {
  return taskParam('context');
}
