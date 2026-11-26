import { DynamicModule, Global, Module } from '@nestjs/common';
import { ServerEnv } from './env.schema';

/** Injection token for the validated, immutable server configuration. */
export const APP_CONFIG = Symbol('APP_CONFIG');

@Global()
@Module({})
export class ConfigModule {
  /**
   * The environment is validated once in `main.ts` (fail fast, before Nest boots) and
   * the resulting object is provided here. Tests pass their own config object.
   */
  static forRoot(config: ServerEnv): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: Object.freeze({ ...config }) }],
      exports: [APP_CONFIG],
    };
  }
}
