import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['modules/bob-live-audio/src/**/*.test.ts'],
  },
});
