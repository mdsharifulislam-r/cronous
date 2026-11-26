import 'reflect-metadata';
import { EnvValidationError } from '@chronos/shared';
import { createApp } from './app.factory';
import { ServerEnv, loadServerEnv } from './config/env.schema';

function loadConfigOrExit(): ServerEnv {
  try {
    return loadServerEnv();
  } catch (error) {
    process.stderr.write(`${error instanceof EnvValidationError ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const config = loadConfigOrExit();
  const app = await createApp(config);

  // Nest's shutdown hooks close the app on SIGTERM/SIGINT; never hang forever doing so.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      setTimeout(() => {
        process.stderr.write(`Graceful shutdown exceeded ${config.CHRONOS_SHUTDOWN_TIMEOUT_MS}ms; forcing exit\n`);
        process.exit(1);
      }, config.CHRONOS_SHUTDOWN_TIMEOUT_MS).unref();
    });
  }

  await app.listen(config.PORT, config.HOST);
}

main().catch((error: unknown) => {
  process.stderr.write(`Fatal startup error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
