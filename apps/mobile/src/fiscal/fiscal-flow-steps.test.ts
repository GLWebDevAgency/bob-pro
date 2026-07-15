import { describe, expect, it } from 'vitest';
import { buildInitialFiscalProfile, confirmeUtilisateur, datumValue, type LegalForm } from '@bob/core';
import { computeFiscalFlowSteps, fiscalFlowRemainingCount, hasFiscalFlowPending } from './fiscal-flow-steps';

const NOW = '2026-07-15T09:00:00.000Z';

function initial(legalForm: LegalForm) {
  return buildInitialFiscalProfile({ id: 'c1', legalForm, trade: 'plombier' }, NOW).toProps();
}

describe('computeFiscalFlowSteps', () => {
  it('profil micro fraîchement dérivé : 4 étapes (TVA hypothèse franchise déjà posée, pas « manquant »)', () => {
    const steps = computeFiscalFlowSteps(initial('micro'));
    expect(steps).toEqual(['legal_regime', 'activity', 'acre', 'versement_liberatoire']);
  });

  it('profil EI (hors micro) : pas de VL (réservé au régime micro), TVA manquante → posée', () => {
    const steps = computeFiscalFlowSteps(initial('EI'));
    expect(steps).toEqual(['legal_regime', 'activity', 'acre', 'vat']);
  });

  it('profil SASU : pas de VL (taxRegime is), TVA manquante → posée', () => {
    const steps = computeFiscalFlowSteps(initial('SASU'));
    expect(steps).toEqual(['legal_regime', 'activity', 'acre', 'vat']);
  });

  it('champ confirmé par l’utilisateur : sort définitivement de la file', () => {
    const profile = initial('micro');
    const withLegalRegimeConfirmed = {
      ...profile,
      legalForm: confirmeUtilisateur(datumValue(profile.legalForm)!, NOW),
      taxRegime: confirmeUtilisateur(datumValue(profile.taxRegime)!, NOW),
    };
    expect(computeFiscalFlowSteps(withLegalRegimeConfirmed)).toEqual(['activity', 'acre', 'versement_liberatoire']);
  });

  it('profil totalement confirmé : file vide, rien en attente', () => {
    const profile = initial('SASU');
    const allConfirmed = {
      ...profile,
      legalForm: confirmeUtilisateur(datumValue(profile.legalForm)!, NOW),
      taxRegime: confirmeUtilisateur(datumValue(profile.taxRegime)!, NOW),
      activityNature: confirmeUtilisateur('bic_service' as const, NOW),
      acre: confirmeUtilisateur({ granted: false }, NOW),
      vatRegime: confirmeUtilisateur('franchise' as const, NOW),
    };
    expect(computeFiscalFlowSteps(allConfirmed)).toEqual([]);
    expect(fiscalFlowRemainingCount(allConfirmed)).toBe(0);
    expect(hasFiscalFlowPending(allConfirmed)).toBe(false);
  });

  it('fiscalFlowRemainingCount(undefined) = 0 (chargement, jamais un compte inventé)', () => {
    expect(fiscalFlowRemainingCount(undefined)).toBe(0);
    expect(hasFiscalFlowPending(undefined)).toBe(false);
  });
});
