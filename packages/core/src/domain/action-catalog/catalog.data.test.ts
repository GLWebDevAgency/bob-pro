import { describe, expect, it } from 'vitest';

import { ACTION_CATALOG_V0 } from './catalog.data';
import { validateCatalog } from './invariants';

describe('ACTION_CATALOG_V0 — invariants sur la donnée réelle', () => {
  it('ne viole aucun invariant structurel', () => {
    expect(validateCatalog(ACTION_CATALOG_V0)).toEqual([]);
  });

  it('couvre toutes les familles du §6.1 (aucun domaine vide)', () => {
    const domains = new Set(ACTION_CATALOG_V0.map((entry) => entry.domain));
    expect([...domains].sort()).toMatchSnapshot();
  });

  it('cliquet : le nombre d’autorités restant à extraire ne peut que baisser', () => {
    const pending = ACTION_CATALOG_V0.filter(
      (entry) => entry.commandAuthority === 'A_EXTRAIRE',
    ).length;
    // Valeur v0 constatée — toute PR qui l'augmente doit être justifiée (spec §4.2 :
    // l'autorité canonique est extraite une fois, jamais contournée).
    expect(pending).toBeLessThanOrEqual(60);
  });

  it('cliquet : les actions closed sont toutes gouvernées par une décision', () => {
    for (const entry of ACTION_CATALOG_V0) {
      if (entry.voiceMode === 'closed') {
        expect(entry.founderDecisionIds.length, entry.actionId).toBeGreaterThan(0);
      }
    }
  });
});
