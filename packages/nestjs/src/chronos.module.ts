import { Chronos, ChronosAdmin, type ChronosOptions } from '@cronous/cronous';
import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { ChronosExplorer } from './chronos.explorer';
import { CHRONOS_MODULE_OPTIONS } from './constants';
import type { ChronosModuleAsyncOptions, ChronosModuleExtras, ChronosModuleOptions, ChronosOptionsFactory } from './interfaces';
import { nestChronosLogger } from './logger';

/**
 * Connects a Nest application to Chronos.
 *
 * Provides (globally by default):
 * - `Chronos`: submit jobs (`queue`), cancel executions, connection status
 * - `ChronosAdmin`: manage jobs, queues, executions, schedules, agents and stats
 *
 * Methods decorated with @Task() are registered as handlers and run in this process.
 *
 * @example
 *   ChronosModule.forRoot({ server: 'http://localhost:8080', project: 'shop' })
 *
 * @example
 *   ChronosModule.forRootAsync({
 *     inject: [ConfigService],
 *     useFactory: (config: ConfigService) => ({
 *       server: config.getOrThrow('CHRONOS_SERVER'),
 *       project: config.getOrThrow('CHRONOS_PROJECT'),
 *       token: config.get('CHRONOS_AGENT_TOKEN'),
 *       apiKey: config.get('CHRONOS_API_KEY'),
 *     }),
 *   })
 */
@Module({})
export class ChronosModule {
  static forRoot(options: ChronosModuleOptions & ChronosModuleExtras): DynamicModule {
    const { isGlobal, ...moduleOptions } = options;
    return ChronosModule.create([{ provide: CHRONOS_MODULE_OPTIONS, useValue: moduleOptions }], [], isGlobal);
  }

  static forRootAsync(options: ChronosModuleAsyncOptions): DynamicModule {
    return ChronosModule.create(ChronosModule.asyncProviders(options), options.imports ?? [], options.isGlobal);
  }

  private static create(optionProviders: Provider[], imports: NonNullable<DynamicModule['imports']>, isGlobal = true): DynamicModule {
    return {
      module: ChronosModule,
      global: isGlobal,
      imports: [DiscoveryModule, ...imports],
      providers: [
        ...optionProviders,
        {
          provide: Chronos,
          useFactory: (options: ChronosModuleOptions) => new Chronos(clientOptions(options)),
          inject: [CHRONOS_MODULE_OPTIONS],
        },
        {
          provide: ChronosAdmin,
          useFactory: (chronos: Chronos, options: ChronosModuleOptions) =>
            chronos.admin({
              ...(options.apiKey !== undefined ? { token: options.apiKey } : {}),
              ...(options.admin?.maxAttempts !== undefined ? { maxAttempts: options.admin.maxAttempts } : {}),
              ...(options.admin?.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.admin.requestTimeoutMs } : {}),
            }),
          inject: [Chronos, CHRONOS_MODULE_OPTIONS],
        },
        ChronosExplorer,
      ],
      exports: [Chronos, ChronosAdmin, CHRONOS_MODULE_OPTIONS],
    };
  }

  private static asyncProviders(options: ChronosModuleAsyncOptions): Provider[] {
    if (options.useFactory) {
      return [{ provide: CHRONOS_MODULE_OPTIONS, useFactory: options.useFactory, inject: options.inject ?? [] }];
    }
    const factory = options.useClass ?? options.useExisting;
    if (!factory) throw new Error('ChronosModule.forRootAsync() needs useFactory, useClass or useExisting');
    return [
      ...(options.useClass ? [{ provide: options.useClass, useClass: options.useClass }] : []),
      {
        provide: CHRONOS_MODULE_OPTIONS,
        useFactory: (optionsFactory: ChronosOptionsFactory) => optionsFactory.createChronosOptions(),
        inject: [factory],
      },
    ];
  }
}

function clientOptions(options: ChronosModuleOptions): ChronosOptions {
  const { apiKey: _apiKey, admin: _admin, worker: _worker, waitForConnection: _wait, logger, ...client } = options;
  return { ...client, logger: logger === undefined ? nestChronosLogger() : logger };
}
