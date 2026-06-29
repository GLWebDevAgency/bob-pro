import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: { environment: 'node' },
  resolve: {
    alias: { '@bob/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)) },
  },
});
