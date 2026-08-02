/**
 * FLAG `mobile_tabs_experiment_v1` — OFF par défaut, et OFF sur tout ce qui n'est pas un OUI
 * explicite. C'est le levier de comparaison de `PERF-13` et le levier de rollback de la barre
 * portée : une expérimentation ne s'allume jamais par accident de configuration.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MOBILE_TABS_EXPERIMENT_ENV,
  MOBILE_TABS_EXPERIMENT_FLAG,
  isMobileTabsExperimentEnabled,
} from './bob-tab-bar-flag';

describe('flag mobile_tabs_experiment_v1', () => {
  it('porte le nom EXACT que le socle écrit — il ne s’invente pas dans le code', () => {
    expect(MOBILE_TABS_EXPERIMENT_FLAG).toBe('mobile_tabs_experiment_v1');
    expect(MOBILE_TABS_EXPERIMENT_ENV).toBe('EXPO_PUBLIC_MOBILE_TABS_EXPERIMENT_V1');
  });

  it('est OFF quand la variable est absente — c’est l’état de livraison', () => {
    expect(isMobileTabsExperimentEnabled(undefined)).toBe(false);
  });

  it.each(['', ' ', '0', 'false', 'FALSE', 'oui', 'yes', 'on', 'enabled', 'null'])(
    'est OFF pour la valeur %o',
    (value) => {
      expect(isMobileTabsExperimentEnabled(value)).toBe(false);
    },
  );

  it.each(['1', 'true', 'TRUE', ' true '])('est ON pour la valeur %o', (value) => {
    expect(isMobileTabsExperimentEnabled(value)).toBe(true);
  });

  it("lit la variable par ACCÈS STATIQUE — la seule forme que le bundler inline (garde source)", () => {
    // Un test unitaire ne peut PAS détecter ce défaut : sous Node, `process.env[nom]` et
    // `process.env.NOM` rendent la même chose. Or dans l'app embarquée, seul l'accès LITTÉRAL
    // est inliné par le bundler — l'accès calculé a valu un flag OFF dans tous les builds
    // (constaté sur l'APK dc12c56c). La garde lit donc la SOURCE, comme la garde d'import
    // Mistral : c'est le seul témoin possible du contrat de bundling.
    const source = readFileSync(join(__dirname, 'bob-tab-bar-flag.ts'), 'utf8');
    // Le CODE seul est jugé : les commentaires ont le droit de nommer la forme interdite
    // (c'est même leur rôle — expliquer pourquoi elle est interdite).
    const code = source
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/\/\/[^\n]*/gu, '');
    // Témoin d'observation : la garde regarde le bon fichier (sa constante y vit, hors commentaire).
    expect(code).toContain("MOBILE_TABS_EXPERIMENT_FLAG = 'mobile_tabs_experiment_v1'");
    // L'accès statique exact est présent…
    expect(code).toContain('process.env.EXPO_PUBLIC_MOBILE_TABS_EXPERIMENT_V1');
    // …et AUCUN accès calculé ne subsiste dans le code (la forme qui a cassé l'inlining).
    expect(code).not.toMatch(/process\.env\[/u);
  });
});
