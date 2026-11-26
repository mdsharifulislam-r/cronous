import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)), 'server-only': fileURLToPath(new URL('./src/test/server-only-stub.ts', import.meta.url)) } },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    // userEvent interactions in jsdom are slow under parallel load; keep a margin.
    testTimeout: 15_000,
    // jsdom workers are memory-hungry; two keep the suite reliable on small machines.
    maxWorkers: 2,
    minWorkers: 1,
  },
});
