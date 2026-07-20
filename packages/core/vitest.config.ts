import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/domain/cabinet/**/*.ts', 'src/application/cabinet/**/*.ts'],
      exclude: [
        'src/domain/cabinet/**/*.test.ts',
        'src/application/cabinet/**/*.test.ts',
      ],
      reporter: ['text', 'json-summary'],
      thresholds: {
        branches: 90,
        functions: 90,
        lines: 90,
        statements: 90,
      },
    },
  },
});
