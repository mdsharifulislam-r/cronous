import type { ChronosLogger } from '@cronous/cronous';
import { Logger } from '@nestjs/common';

function format(message: string, args: unknown[]): string {
  if (args.length === 0) return message;
  return `${message} ${args.map((arg) => (arg instanceof Error ? arg.message : typeof arg === 'string' ? arg : safeJson(arg))).join(' ')}`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Routes SDK logs through Nest's logger, so they use the application's logger. */
export function nestChronosLogger(context = 'Chronos'): ChronosLogger {
  const logger = new Logger(context);
  return {
    debug: (message, ...args) => logger.debug(format(message, args)),
    info: (message, ...args) => logger.log(format(message, args)),
    warn: (message, ...args) => logger.warn(format(message, args)),
    error: (message, ...args) => logger.error(format(message, args)),
  };
}
