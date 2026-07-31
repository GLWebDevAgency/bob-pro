import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * `@bob/ui` est ALIASÉ VERS SA SOURCE — sinon il est résolu depuis `node_modules` (lien du
 * workspace), donc traité comme une dépendance EXTERNE, chargée nativement par Node et hors de
 * portée de `vi.mock`. Son `import 'react-native'` atteignait alors le vrai paquet, dont
 * l'`index.js` est en Flow : `SyntaxError: Unexpected token 'typeof'`, et aucun test ne
 * collectait. Aliasé vers la source, il entre dans le graphe transformé par Vite et les
 * doublons de `react-native` s'appliquent.
 *
 * Les tests qui mockent `@bob/ui` en entier (`ConfirmSheet`, `customer-form`…) ne changent pas
 * de comportement : un `vi.mock` prime sur l'alias.
 */
const bobUiSource = fileURLToPath(new URL('../../packages/ui/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: { alias: { '@bob/ui': bobUiSource } },
  test: {
    environment: 'node',
    include: [
      'src/realtime/**/*.test.ts?(x)',
      'src/agent/**/*.test.ts?(x)',
      'src/audio/**/*.test.ts',
      'src/auth-recovery/**/*.test.ts',
      'src/auth-confirmation/**/*.test.ts',
      'src/data/**/*.test.ts',
      'src/documents/**/*.test.ts',
      'src/expenses/**/*.test.ts',
      'src/facture-directe/**/*.test.ts',
      'src/assistant/**/*.test.ts',
      'src/voice-flow/**/*.test.ts',
      'src/fiscal/**/*.test.ts',
      'src/finance/**/*.test.ts',
      'src/home/**/*.test.ts',
      'src/monetization/**/*.test.ts',
      'src/observability/**/*.test.ts',
      'src/quote-draft/**/*.test.ts?(x)',
      'src/scan/**/*.test.ts',
      'src/components/**/*.test.ts?(x)',
      'src/lib/**/*.test.ts',
    ],
  },
});
