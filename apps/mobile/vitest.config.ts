import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'src/realtime/**/*.test.ts',
      'src/agent/**/*.test.ts',
      'src/audio/**/*.test.ts',
      'src/auth-recovery/**/*.test.ts',
      'src/auth-confirmation/**/*.test.ts',
      'src/data/**/*.test.ts',
      'src/documents/**/*.test.ts',
      'src/assistant/**/*.test.ts',
      'src/voice-flow/**/*.test.ts',
      'src/fiscal/**/*.test.ts',
      'src/finance/**/*.test.ts',
      'src/home/**/*.test.ts',
      'src/monetization/**/*.test.ts',
      'src/quote-draft/**/*.test.ts',
      'src/scan/**/*.test.ts',
      'src/components/**/*.test.ts?(x)',
      'src/lib/**/*.test.ts',
    ],
  },
});
