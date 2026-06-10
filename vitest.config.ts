import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    exclude: ['**/auth-manual.ts'],
    globals: false,
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
  },
});
