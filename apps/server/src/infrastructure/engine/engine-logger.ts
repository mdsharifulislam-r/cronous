import { Logger } from '@nestjs/common';
import type { EngineLogger } from '@chronos/engine';

/** Adapts the Nest (pino-backed) logger to the engine's structured logger interface. */
export function nestEngineLogger(context: string): EngineLogger {
  const logger = new Logger(context);
  return {
    debug: (message, ctx) => logger.debug(ctx ? { ...ctx, msg: message } : message),
    info: (message, ctx) => logger.log(ctx ? { ...ctx, msg: message } : message),
    warn: (message, ctx) => logger.warn(ctx ? { ...ctx, msg: message } : message),
    error: (message, ctx) => logger.error(ctx ? { ...ctx, msg: message } : message),
  };
}
