import path from 'node:path';
import type { WorkerHandler } from '@chronos/engine';

/**
 * Loads Mode C handlers from a module chosen by the operator (CHRONOS_WORKER_HANDLERS).
 * The module exports an object mapping job names to functions, either as its default
 * export or as `handlers`:
 *
 *   module.exports = { 'cleanup-temp-files': async (ctx) => { ... } };
 */
export function loadHandlers(modulePath: string | undefined): Record<string, WorkerHandler> {
  if (!modulePath) return {};
  const resolved = path.resolve(modulePath);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const loaded = require(resolved) as Record<string, unknown>;
  const candidate = (loaded.handlers ?? loaded.default ?? loaded) as Record<string, unknown>;
  if (typeof candidate !== 'object' || candidate === null) throw new Error(`${resolved} must export an object of handlers`);

  const handlers: Record<string, WorkerHandler> = {};
  for (const [name, handler] of Object.entries(candidate)) {
    if (name === 'default' || name === 'handlers' || name === '__esModule') continue;
    if (typeof handler !== 'function') throw new Error(`Handler "${name}" in ${resolved} is not a function`);
    handlers[name] = handler as WorkerHandler;
  }
  return handlers;
}
