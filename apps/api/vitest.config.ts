import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Les suites vitest vivent sous src/. Les scripts d'exploitation (release-flag-ops) sont testés
// par node:test (`pnpm test:release-flags`), enchaîné dans le script `test` — sans cette borne,
// l'include par défaut de vitest ramasse scripts/*.test.mjs et échoue (« No test suite found »).
export default defineConfig({
  resolve: {
    alias: [
      {
        // Les fixtures restent une entrée TEST uniquement : aucun dist-testing préexistant n'est
        // requis et le garde d'artefact API continue d'interdire cet import en production.
        find: '@bob/core/testing',
        replacement: fileURLToPath(new URL('../../packages/core/src/testing.ts', import.meta.url)),
      },
      {
        // Même frontière pour les doubles IA : Vitest résout la source de test, tandis que
        // l'artefact API de production continue de refuser explicitement @bob/ai/testing.
        find: '@bob/ai/testing',
        replacement: fileURLToPath(new URL('../../packages/ai/src/testing.ts', import.meta.url)),
      },
    ],
  },
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
