/**
 * FLAG `mobile_tabs_experiment_v1` — la barre PORTÉE contre la barre LIVRÉE, au MÊME COMMIT.
 *
 * POURQUOI IL EXISTE. `PERF-13` n'est pas exécutable sans lui : son protocole exige « flag
 * `mobile_tabs_experiment_v1` comparé ON/OFF sur le même commit »
 * ([10 § Protocole PERF-13](../../../docs/mobile-experience/10-performance-observability.md)).
 * Et c'est aussi le levier de rollback nommé par § Owners et rollback : un seul indicateur hors
 * seuil, le flag retombe à OFF et la `BottomTabBar` livrée reprend la main SANS migration à
 * chaud.
 *
 * IL EST OFF PAR DÉFAUT, et il le restera jusqu'à ce que `PERF-13` rende un verdict sur appareil
 * réel. Ce lot ne peut pas exécuter ce protocole — il exige des appareils, un manifeste
 * `PERF-CALIBRATION` signé et un build release. Sans manifeste, `PERF-13` vaut `NOT RUN`, et une
 * barre `NOT RUN` n'est pas livrable quel que soit son rendu à l'œil. Le flag est donc la forme
 * honnête de la livraison : le code est là, mesurable, et il n'est allumé par personne.
 *
 * LECTURE FAIL-CLOSED. Toute valeur qui n'est pas exactement `'1'` ou `'true'` vaut OFF —
 * y compris une variable absente, vide, ou mal orthographiée. Une expérimentation ne s'allume
 * jamais par accident de configuration.
 */

/** Nom exact du flag, tel que le socle l'écrit. Il ne s'invente pas ici. */
export const MOBILE_TABS_EXPERIMENT_FLAG = 'mobile_tabs_experiment_v1';

/**
 * Variable publique correspondante. `EXPO_PUBLIC_` est le préfixe que le bundler inline — c'est
 * la seule famille lisible depuis le code client, et c'est déjà la convention du dépôt
 * (`src/config/legal.ts`).
 */
export const MOBILE_TABS_EXPERIMENT_ENV = 'EXPO_PUBLIC_MOBILE_TABS_EXPERIMENT_V1';

/** Les deux seules valeurs qui ALLUMENT. Tout le reste vaut OFF. */
const TRUTHY = new Set(['1', 'true']);

export function isMobileTabsExperimentEnabled(
  raw: string | undefined = process.env[MOBILE_TABS_EXPERIMENT_ENV],
): boolean {
  return raw !== undefined && TRUTHY.has(raw.trim().toLowerCase());
}
