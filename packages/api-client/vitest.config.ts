import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: { environment: 'node' },
  resolve: {
    alias: [
      {
        find: '@bob/core/testing',
        replacement: fileURLToPath(new URL('../core/src/testing.ts', import.meta.url)),
      },
      {
        find: '@bob/core',
        replacement: fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      },
      {
        find: '@bob/ai/testing',
        replacement: fileURLToPath(new URL('../ai/src/testing.ts', import.meta.url)),
      },
      {
        find: '@bob/ai',
        replacement: fileURLToPath(new URL('../ai/src/index.ts', import.meta.url)),
      },
    ],
  },
});
