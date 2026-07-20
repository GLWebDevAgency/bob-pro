import { describe, expect, it } from 'vitest';
import {
  buildLegalIdentityPatch,
  canSaveLegalIdentity,
  legalIdentityErrors,
  type LegalIdentityValues,
} from './legal-identity-edit.logic';

/** Le cas de production : société provisionnée avec adresse mais SANS n° d'immatriculation. */
const CURRENT: LegalIdentityValues = {
  rcsOrRm: '',
  line1: '19 QUAI DE LA SEINE',
  zip: '75019',
  city: 'PARIS',
};

describe('legalIdentityErrors', () => {
  it('signale le n° d’immatriculation manquant (le blocage réel d’émission)', () => {
    expect(legalIdentityErrors(CURRENT)).toEqual({ rcsOrRm: true, line1: false, city: false });
  });

  it('signale rue et ville manquantes (les 2 exigences d’assertCanIssue sur l’adresse)', () => {
    expect(
      legalIdentityErrors({ rcsOrRm: '732 829 320 RCS Paris', line1: '  ', zip: '', city: '' }),
    ).toEqual({ rcsOrRm: false, line1: true, city: true });
  });

  it('refuse les valeurs au-delà des bornes serveur (rejet avant le réseau)', () => {
    expect(legalIdentityErrors({ ...CURRENT, rcsOrRm: 'x'.repeat(101) }).rcsOrRm).toBe(true);
    expect(legalIdentityErrors({ ...CURRENT, rcsOrRm: 'x'.repeat(100) }).rcsOrRm).toBe(false);
    expect(legalIdentityErrors({ ...CURRENT, line1: 'x'.repeat(201) }).line1).toBe(true);
    expect(legalIdentityErrors({ ...CURRENT, city: 'x'.repeat(101) }).city).toBe(true);
  });

  it('n’exige PAS le code postal — le domaine ne le demande pas pour émettre', () => {
    expect(canSaveLegalIdentity({ ...CURRENT, rcsOrRm: 'RM 92', zip: '' })).toBe(true);
    expect(canSaveLegalIdentity({ ...CURRENT, rcsOrRm: 'RM 92', zip: 'x'.repeat(21) })).toBe(false);
  });
});

describe('buildLegalIdentityPatch', () => {
  it('n’envoie QUE le n° d’immatriculation quand seule cette valeur est confirmée', () => {
    const next = { ...CURRENT, rcsOrRm: '732 829 320 RCS Paris' };
    expect(buildLegalIdentityPatch(CURRENT, next)).toEqual({ rcsOrRm: '732 829 320 RCS Paris' });
  });

  it('envoie l’adresse EN BLOC dès qu’un seul de ses sous-champs bouge', () => {
    const next = { ...CURRENT, rcsOrRm: 'RM 92', city: 'Paris' };
    expect(buildLegalIdentityPatch(CURRENT, next)).toEqual({
      rcsOrRm: 'RM 92',
      address: { line1: '19 QUAI DE LA SEINE', zip: '75019', city: 'Paris' },
    });
  });

  it('rend null quand rien n’a changé — une suggestion affichée mais non confirmée n’est JAMAIS écrite', () => {
    expect(buildLegalIdentityPatch(CURRENT, { ...CURRENT })).toBeNull();
    // Espaces seuls : pas une modification.
    expect(buildLegalIdentityPatch(CURRENT, { ...CURRENT, city: '  PARIS  ' })).toBeNull();
  });

  it('rend null (fail-closed) quand la saisie est invalide — jamais un patch partiel douteux', () => {
    expect(buildLegalIdentityPatch(CURRENT, { ...CURRENT, rcsOrRm: '   ' })).toBeNull();
    expect(
      buildLegalIdentityPatch(CURRENT, { ...CURRENT, rcsOrRm: 'RM 92', line1: '' }),
    ).toBeNull();
  });

  it('normalise (trim) les valeurs envoyées au serveur', () => {
    const next = { rcsOrRm: '  RM 92  ', line1: ' 1 rue A ', zip: ' 75019 ', city: ' Paris ' };
    expect(buildLegalIdentityPatch(CURRENT, next)).toEqual({
      rcsOrRm: 'RM 92',
      address: { line1: '1 rue A', zip: '75019', city: 'Paris' },
    });
  });
});
