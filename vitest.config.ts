import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Workspace packages resolve to source so tests never need a prior build.
    alias: {
      '@postcode/index-format': fileURLToPath(new URL('./packages/index-format/src/index.ts', import.meta.url)),
      '@postcode/indexer': fileURLToPath(new URL('./packages/indexer/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    testTimeout: 30_000,
    pool: 'forks',
    // The refresh test checks that old index buffers are released after GC.
    execArgv: ['--expose-gc'],
  },
});
