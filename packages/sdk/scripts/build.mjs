// Builds the publishable package:
//   dist/index.js   CommonJS bundle    dist/index.mjs  ES module bundle
//   dist/*.d.ts     type declarations (tsc)
// The internal @chronos/protocol workspace package is bundled in; real dependencies
// (ws, zod, cron-parser) stay external and are installed by npm.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {});
rmSync('dist', { recursive: true, force: true });

const common = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  external,
  // Bundle the workspace protocol package from source, so both formats get real imports.
  alias: { '@chronos/protocol': '../protocol/src/index.ts' },
  logLevel: 'warning',
};
await build({ ...common, format: 'cjs', outfile: 'dist/index.js' });
await build({ ...common, format: 'esm', outfile: 'dist/index.mjs' });

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json', '--emitDeclarationOnly', '--declarationMap', 'false'], { stdio: 'inherit' });
