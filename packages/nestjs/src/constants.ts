/** Injection token for the resolved ChronosModule options. */
export const CHRONOS_MODULE_OPTIONS = Symbol('CHRONOS_MODULE_OPTIONS');

/** Metadata key set by @Task() on a handler method. */
export const CHRONOS_TASK_METADATA = 'chronos:task';

/** Metadata key set by @Payload() / @Ctx() on handler parameters. */
export const CHRONOS_TASK_PARAMS_METADATA = 'chronos:task-params';
