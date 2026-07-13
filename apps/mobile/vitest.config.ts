import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/realtime/**/*.test.ts', 'src/audio/**/*.test.ts'],
  },
});
