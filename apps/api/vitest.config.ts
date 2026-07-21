import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

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
  // Les exports `testing` pointent volontairement vers des artefacts séparés, absents d'un
  // checkout propre tant qu'aucun build de certification n'a tourné. Vitest lit directement
  // leurs entrées source test-only : `pnpm test` reste donc reproductible sans embarquer ces
  // doubles dans les artefacts de production.
  resolve: {
    alias: [
      {
        find: '@bob/core/testing',
        replacement: fileURLToPath(
          new URL('../../packages/core/src/testing.ts', import.meta.url),
        ),
      },
      {
        find: '@bob/ai/testing',
        replacement: fileURLToPath(
          new URL('../../packages/ai/src/testing.ts', import.meta.url),
        ),
      },
    ],
  },
});
