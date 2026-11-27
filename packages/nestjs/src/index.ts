import 'reflect-metadata';

export { ChronosModule } from './chronos.module';
export { ChronosExplorer } from './chronos.explorer';
export type { DiscoveredTask } from './chronos.explorer';
export { Task, TaskReg, Payload, Ctx } from './decorators';
export type { TaskParamMetadata, TaskParamType } from './decorators';
export type { ChronosModuleAsyncOptions, ChronosModuleExtras, ChronosModuleOptions, ChronosOptionsFactory, TaskMetadata } from './interfaces';
export { CHRONOS_MODULE_OPTIONS, CHRONOS_TASK_METADATA, CHRONOS_TASK_PARAMS_METADATA } from './constants';
export { nestChronosLogger } from './logger';

// The Chronos client, admin API, errors and types, so applications need a single import.
export * from '@cronous/cronous';
