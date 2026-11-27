import type { ChronosLogger, ChronosOptions, TaskOptions } from '@cronous/cronous';
import type { InjectionToken, ModuleMetadata, OptionalFactoryDependency, Type } from '@nestjs/common';

export interface ChronosModuleOptions extends Omit<ChronosOptions, 'logger'> {
  /**
   * Project API key (chr_p_…) for the injectable ChronosAdmin. Defaults to
   * process.env.CHRONOS_API_KEY. Not needed if you never inject ChronosAdmin.
   */
  apiKey?: string;
  /** Extra settings for the ChronosAdmin client. */
  admin?: { maxAttempts?: number; requestTimeoutMs?: number };
  /**
   * Run the @Task() handlers found in this application. Default true. Set false in
   * processes that should only submit jobs or use the admin API (e.g. an API-only pod);
   * those need no agent token.
   */
  worker?: boolean;
  /**
   * Make application bootstrap wait until the agent connection is established. Default
   * true, so a bad token or invalid task fails startup. With false, the app starts at
   * once and connection errors are logged.
   */
  waitForConnection?: boolean;
  /** Logger for the SDK. Defaults to a Nest Logger with the "Chronos" context; false silences it. */
  logger?: ChronosLogger | false;
}

export interface ChronosModuleExtras {
  /** Register the module globally, so feature modules can inject Chronos without importing it. Default true. */
  isGlobal?: boolean;
}

export interface ChronosOptionsFactory {
  createChronosOptions(): ChronosModuleOptions | Promise<ChronosModuleOptions>;
}

export interface ChronosModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'>, ChronosModuleExtras {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same signature as Nest factory providers
  useFactory?: (...args: any[]) => ChronosModuleOptions | Promise<ChronosModuleOptions>;
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
  useClass?: Type<ChronosOptionsFactory>;
  useExisting?: Type<ChronosOptionsFactory>;
}

/** Options accepted by @Task(): the task name plus everything chronos.task() accepts. */
export interface TaskMetadata extends TaskOptions {
  name: string;
}
