import { defineConfig } from 'vitest/config';

// Les suites vitest vivent sous src/. Les scripts d'exploitation (release-flag-ops) sont testés
// par node:test (`pnpm test:release-flags`), enchaîné dans le script `test` — sans cette borne,
// l'include par défaut de vitest ramasse scripts/*.test.mjs et échoue (« No test suite found »).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
