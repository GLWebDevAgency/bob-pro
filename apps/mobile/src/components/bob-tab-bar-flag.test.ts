/**
 * FLAG `mobile_tabs_experiment_v1` — OFF par défaut, et OFF sur tout ce qui n'est pas un OUI
 * explicite. C'est le levier de comparaison de `PERF-13` et le levier de rollback de la barre
 * portée : une expérimentation ne s'allume jamais par accident de configuration.
 */
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
});
