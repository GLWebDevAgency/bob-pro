import { defineConfig } from 'vitest/config';

// Les suites vitest vivent sous src/. Les scripts d'exploitation (release-flag-ops) sont testés
// par node:test (`pnpm test:release-flags`), enchaîné dans le script `test` — sans cette borne,
// l'include par défaut de vitest ramasse scripts/*.test.mjs et échoue (« No test suite found »).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Le runtime normal est live par défaut ; les suites unitaires qui utilisent les adapters
    // in-memory optent explicitement pour le harness démo.
    env: {
      DEMO_MODE: 'true',
      CABINET_INVITATION_TOKEN_ENCRYPTION_KEY:
        'bob-pro-test-only-cabinet-invitation-key-2026',
    },
  },
});
