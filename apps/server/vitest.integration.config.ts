import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Integration tests run against real PostgreSQL and Redis (see docker/compose.test.yaml).
 * They run in a single fork so they can share one database that is reset per file.
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/**/*.int-spec.ts'],
    environment: 'node',
    globalSetup: ['test/setup/global-setup.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
