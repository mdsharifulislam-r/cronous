import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC is required because esbuild (Vitest's default) does not emit decorator
// metadata, which Nest's dependency injection relies on.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
  },
});
