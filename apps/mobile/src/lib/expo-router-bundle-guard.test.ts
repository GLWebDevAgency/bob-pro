/**
 * LA GARDE QUI REND LES TESTS D'`app/` SÛRS.
 *
 * `apps/mobile/vitest.config.ts` couvre désormais `app/**` — c'était un trou du dépôt : tous les
 * points de montage d'expo-router vivaient hors de toute suite. Mais poser un test SOUS `app/`
 * n'est pas gratuit : `expo-router` construit sa table de routes depuis un `require.context` qui
 * prend TOUT fichier `.ts/.tsx/.js/.jsx` du dossier
 * (`expo-router/_ctx.ios.js`). Un `_layout.test.tsx` deviendrait donc une route, et Metro
 * tenterait de résoudre `vitest`, `react-test-renderer` et `node:fs` dans le bundle de
 * l'application — une erreur de bundling, pas un avertissement.
 *
 * CE QUI L'EN EMPÊCHE : le `resolver.blockList` par défaut d'Expo écarte déjà tout `__tests__/`.
 * Un fichier bloqué n'entre pas dans la carte de fichiers de Metro
 * (`metro/src/node-haste/DependencyGraph/createFileMap.js` : `blockList` → `ignorePattern`), et
 * `require.context` ne lit QUE cette carte
 * (`metro/src/node-haste/DependencyGraph.js`, `matchFilesWithContext`). Les tests d'`app/`
 * vivent donc dans des `__tests__/`.
 *
 * CE TEST EXISTE PARCE QUE CETTE CHAÎNE EST UNE HYPOTHÈSE SUR UN OUTIL TIERS. Elle est vraie
 * aujourd'hui ; une montée d'Expo peut la changer sans prévenir, et le symptôme serait un build
 * cassé, pas un test rouge. On la VÉRIFIE donc, sur le vrai `getDefaultConfig` du projet.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

interface MetroConfig {
  resolver: { blockList?: RegExp | readonly RegExp[] };
}

function blockList(): readonly RegExp[] {
  const { getDefaultConfig } = require('expo/metro-config') as {
    getDefaultConfig: (root: string) => MetroConfig;
  };
  const raw = getDefaultConfig(projectRoot).resolver.blockList;
  expect(raw, 'Expo ne pose plus aucun `resolver.blockList`').toBeDefined();
  return Array.isArray(raw) ? raw : [raw as RegExp];
}

const blocked = (path: string): boolean => blockList().some((pattern) => pattern.test(path));

describe('les tests d’`app/` ne partent pas dans le bundle', () => {
  it('un test posé dans un `__tests__/` d’`app/` est BLOQUÉ par Metro', () => {
    expect(blocked(join(projectRoot, 'app', '(tabs)', '__tests__', '_layout.test.tsx'))).toBe(true);
    expect(blocked(join(projectRoot, 'app', '__tests__', 'quoi-que-ce-soit.test.ts'))).toBe(true);
  });

  it('les ROUTES, elles, ne sont pas bloquées — sinon la garde masquerait un bundle vide', () => {
    // Le témoin qui empêche ce fichier de devenir vert en ne regardant plus rien : si le
    // `blockList` bloquait tout, le test ci-dessus resterait vert pour toujours.
    expect(blocked(join(projectRoot, 'app', '(tabs)', '_layout.tsx'))).toBe(false);
    expect(blocked(join(projectRoot, 'app', 'devis', 'new.tsx'))).toBe(false);
  });

  it('un test posé À CÔTÉ d’une route, hors `__tests__/`, n’est PAS bloqué — d’où la convention', () => {
    // Ce n'est pas un défaut à corriger, c'est la RAISON de la convention `__tests__/` : le
    // jour où quelqu'un pose `app/(tabs)/_layout.test.tsx`, ce test rappelle ce qui se passe.
    expect(blocked(join(projectRoot, 'app', '(tabs)', '_layout.test.tsx'))).toBe(false);
  });
});
