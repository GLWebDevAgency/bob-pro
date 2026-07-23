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
  tvaIntracom: '',
  line1: '19 QUAI DE LA SEINE',
  zip: '75019',
  city: 'PARIS',
};
const VAT_REQUIRED = { siren: '732829320', vatRequired: true } as const;
const VAT_OPTIONAL = { siren: '732829320', vatRequired: false } as const;

describe('legalIdentityErrors', () => {
  it('signale le n° d’immatriculation manquant (le blocage réel d’émission)', () => {
    expect(legalIdentityErrors(CURRENT, VAT_REQUIRED)).toEqual({
      rcsOrRm: true,
      tvaIntracom: true,
      line1: false,
      city: false,
    });
  });

  it('signale rue et ville manquantes (les 2 exigences d’assertCanIssue sur l’adresse)', () => {
    expect(
      legalIdentityErrors(
        {
          rcsOrRm: '732 829 320 RCS Paris',
          tvaIntracom: 'FR44732829320',
          line1: '  ',
          zip: '',
          city: '',
        },
        VAT_REQUIRED,
      ),
    ).toEqual({ rcsOrRm: false, tvaIntracom: false, line1: true, city: true });
  });

  it('refuse les valeurs au-delà des bornes serveur (rejet avant le réseau)', () => {
    expect(legalIdentityErrors({ ...CURRENT, rcsOrRm: 'x'.repeat(101) }, VAT_OPTIONAL).rcsOrRm).toBe(true);
    expect(legalIdentityErrors({ ...CURRENT, rcsOrRm: 'x'.repeat(100) }, VAT_OPTIONAL).rcsOrRm).toBe(false);
    expect(legalIdentityErrors({ ...CURRENT, line1: 'x'.repeat(201) }, VAT_OPTIONAL).line1).toBe(true);
    expect(legalIdentityErrors({ ...CURRENT, city: 'x'.repeat(101) }, VAT_OPTIONAL).city).toBe(true);
  });

  it('n’exige PAS le code postal — le domaine ne le demande pas pour émettre', () => {
    expect(canSaveLegalIdentity({ ...CURRENT, rcsOrRm: 'RM 92', zip: '' }, VAT_OPTIONAL)).toBe(true);
    expect(canSaveLegalIdentity({ ...CURRENT, rcsOrRm: 'RM 92', zip: 'x'.repeat(21) }, VAT_OPTIONAL)).toBe(false);
  });

  it('exige une TVA réelle au régime réel, mais pas en franchise', () => {
    const valid = { ...CURRENT, rcsOrRm: 'RM 92', tvaIntracom: 'FR44732829320' };
    expect(canSaveLegalIdentity(valid, VAT_REQUIRED)).toBe(true);
    expect(canSaveLegalIdentity({ ...CURRENT, rcsOrRm: 'RM 92' }, VAT_REQUIRED)).toBe(false);
    expect(canSaveLegalIdentity({ ...CURRENT, rcsOrRm: 'RM 92' }, VAT_OPTIONAL)).toBe(true);
    expect(
      legalIdentityErrors({ ...valid, tvaIntracom: 'FR24732829320' }, VAT_REQUIRED).tvaIntracom,
    ).toBe(true);
  });
});

describe('buildLegalIdentityPatch', () => {
  it('n’envoie QUE le n° d’immatriculation quand seule cette valeur est confirmée', () => {
    const next = { ...CURRENT, rcsOrRm: '732 829 320 RCS Paris' };
    expect(buildLegalIdentityPatch(CURRENT, next, VAT_OPTIONAL)).toEqual({ rcsOrRm: '732 829 320 RCS Paris' });
  });

  it('envoie l’adresse EN BLOC dès qu’un seul de ses sous-champs bouge', () => {
    const next = { ...CURRENT, rcsOrRm: 'RM 92', city: 'Paris' };
    expect(buildLegalIdentityPatch(CURRENT, next, VAT_OPTIONAL)).toEqual({
      rcsOrRm: 'RM 92',
      address: { line1: '19 QUAI DE LA SEINE', zip: '75019', city: 'Paris' },
    });
  });

  it('rend null quand rien n’a changé — une suggestion affichée mais non confirmée n’est JAMAIS écrite', () => {
    expect(buildLegalIdentityPatch(CURRENT, { ...CURRENT }, VAT_OPTIONAL)).toBeNull();
    // Espaces seuls : pas une modification.
    expect(buildLegalIdentityPatch(CURRENT, { ...CURRENT, city: '  PARIS  ' }, VAT_OPTIONAL)).toBeNull();
  });

  it('rend null (fail-closed) quand la saisie est invalide — jamais un patch partiel douteux', () => {
    expect(buildLegalIdentityPatch(CURRENT, { ...CURRENT, rcsOrRm: '   ' }, VAT_OPTIONAL)).toBeNull();
    expect(
      buildLegalIdentityPatch(CURRENT, { ...CURRENT, rcsOrRm: 'RM 92', line1: '' }, VAT_OPTIONAL),
    ).toBeNull();
  });

  it('normalise (trim) les valeurs envoyées au serveur', () => {
    const next = {
      rcsOrRm: '  RM 92  ',
      tvaIntracom: ' fr44 732829320 ',
      line1: ' 1 rue A ',
      zip: ' 75019 ',
      city: ' Paris ',
    };
    expect(buildLegalIdentityPatch(CURRENT, next, VAT_REQUIRED)).toEqual({
      rcsOrRm: 'RM 92',
      tvaIntracom: 'FR44732829320',
      address: { line1: '1 rue A', zip: '75019', city: 'Paris' },
    });
  });

  it('envoie null seulement pour effacer une TVA optionnelle déjà confirmée', () => {
    const current = { ...CURRENT, rcsOrRm: 'RM 92', tvaIntracom: 'FR44732829320' };
    expect(buildLegalIdentityPatch(current, { ...current, tvaIntracom: '' }, VAT_OPTIONAL)).toEqual({
      tvaIntracom: null,
    });
  });
});
