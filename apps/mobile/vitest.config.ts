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
      /**
       * `app/` — TOUS LES POINTS DE MONTAGE d'expo-router, et ils étaient hors de toute suite.
       *
       * La liste ci-dessous n'énumérait que des chemins de `src/` : rien ne regardait `app/`,
       * donc rien ne pouvait y rougir. Une revue par mutation l'a chiffré — treize mutations
       * appliquées au seul `app/(tabs)/_layout.tsx` ont toutes SURVÉCU, dont l'INVERSION du flag
       * `mobile_tabs_experiment_v1`. Ce n'est pas le défaut d'un lot, c'est celui du dépôt :
       * cette ligne protège tout futur travail de navigation.
       *
       * Un test posé sous `app/` deviendrait une ROUTE — `expo-router/_ctx.ios.js` prend TOUT
       * fichier `.ts/.tsx/.js/.jsx` du dossier, et Metro tenterait alors de résoudre `vitest`
       * dans le bundle de l'application. Les tests d'`app/` vivent donc dans des dossiers
       * `__tests__/`, que le `resolver.blockList` d'Expo écarte déjà ;
       * `src/lib/expo-router-bundle-guard.test.ts` le VÉRIFIE au lieu de le supposer.
       */
      'app/**/*.test.ts?(x)',
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
