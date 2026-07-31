import { describe, expect, it } from 'vitest';
import {
  buildLegalIdentityPatch,
  canSaveLegalIdentity,
  formatCapitalSocialEuros,
  legalIdentityErrors,
  parseCapitalSocialEurosToCents,
  type LegalIdentityValues,
} from './legal-identity-edit.logic';

/** Le cas de production : entreprise provisionnée avec adresse mais SANS n° d'immatriculation. */
const CURRENT: LegalIdentityValues = {
  rcsOrRm: '',
  tvaIntracom: '',
  capitalSocialEuros: '',
  line1: '19 QUAI DE LA SEINE',
  zip: '75019',
  city: 'PARIS',
};
const SIREN = '732829320';
/** EI au réel : TVA exigée, capital sans objet (une EI n'a pas de capital — art. R123-238). */
const VAT_REQUIRED = { siren: SIREN, vatRequired: true, capitalRequired: false } as const;
/** EI en franchise : ni TVA ni capital exigés. */
const VAT_OPTIONAL = { siren: SIREN, vatRequired: false, capitalRequired: false } as const;
/** Société (SAS/SARL/EURL/SASU) en franchise : capital exigé par `Company.isSociete()` —
 *  le cas FLY SERVICES (SAS au réel = SOCIETE_REEL). */
const SOCIETE = { siren: SIREN, vatRequired: false, capitalRequired: true } as const;
const SOCIETE_REEL = { siren: SIREN, vatRequired: true, capitalRequired: true } as const;

describe('parseCapitalSocialEurosToCents — euros → centimes SANS flottant', () => {
  it.each([
    ['1', 100],
    ['1,00', 100],
    ['0,01', 1],
    ['10 000', 1_000_000],
    ['10\u00a0000', 1_000_000], // espace insécable (montant collé depuis un document)
    ['10\u202f000,5', 1_000_050], // espace fine insécable + une seule décimale
    ['10000,50', 1_000_050],
    ['1.5', 150],
    // Le piège flottant : parseFloat('1,15'.replace(',','.')) * 100 === 114.99999999999999.
    ['1,15', 115],
  ])('convertit %s en %d centimes exacts', (raw, cents) => {
    expect(parseCapitalSocialEurosToCents(raw)).toBe(cents);
  });

  it.each([
    ['1,555', 'plus de 2 décimales'],
    ['0', 'zéro — un capital de société est strictement positif'],
    ['0,00', 'zéro déguisé'],
    ['-5', 'négatif'],
    ['', 'vide (la vacuité se juge avec le contexte, pas ici)'],
    ['abc', 'non numérique'],
    ['1.000,50', 'double séparateur'],
  ])('refuse %s (%s)', (raw) => {
    expect(parseCapitalSocialEurosToCents(raw)).toBeNull();
  });
});

describe('formatCapitalSocialEuros — affichage français exact (centimes → euros)', () => {
  it('groupe les milliers en espace fine insécable et omet les centimes nuls', () => {
    expect(formatCapitalSocialEuros(1_000_000)).toBe('10\u202f000\u202f€');
    expect(formatCapitalSocialEuros(150_050)).toBe('1\u202f500,50\u202f€');
    expect(formatCapitalSocialEuros(100)).toBe('1\u202f€');
    expect(formatCapitalSocialEuros(1)).toBe('0,01\u202f€');
  });
});

describe('legalIdentityErrors', () => {
  it('signale le n° d’immatriculation manquant (le blocage réel d’émission)', () => {
    expect(legalIdentityErrors(CURRENT, VAT_REQUIRED)).toEqual({
      rcsOrRm: true,
      tvaIntracom: true,
      capitalSocial: false,
      line1: false,
      zip: false,
      city: false,
    });
  });

  it('signale rue, code postal et ville manquants (l’adresse COMPLÈTE d’assertCanIssue)', () => {
    expect(
      legalIdentityErrors(
        {
          rcsOrRm: '732 829 320 RCS Paris',
          tvaIntracom: 'FR44732829320',
          capitalSocialEuros: '',
          line1: '  ',
          zip: '',
          city: '',
        },
        VAT_REQUIRED,
      ),
    ).toEqual({
      rcsOrRm: false,
      tvaIntracom: false,
      capitalSocial: false,
      line1: true,
      zip: true,
      city: true,
    });
  });

  it('refuse les valeurs au-delà des bornes serveur (rejet avant le réseau)', () => {
    expect(legalIdentityErrors({ ...CURRENT, rcsOrRm: 'x'.repeat(101) }, VAT_OPTIONAL).rcsOrRm).toBe(true);
    expect(legalIdentityErrors({ ...CURRENT, rcsOrRm: 'x'.repeat(100) }, VAT_OPTIONAL).rcsOrRm).toBe(false);
    expect(legalIdentityErrors({ ...CURRENT, line1: 'x'.repeat(201) }, VAT_OPTIONAL).line1).toBe(true);
    expect(legalIdentityErrors({ ...CURRENT, zip: 'x'.repeat(21) }, VAT_OPTIONAL).zip).toBe(true);
    expect(legalIdentityErrors({ ...CURRENT, city: 'x'.repeat(101) }, VAT_OPTIONAL).city).toBe(true);
  });

  it('exige le code postal — le domaine le demande pour émettre (adresse complète)', () => {
    // Ce test affirmait l'INVERSE avant le durcissement Factur-X d'assertCanIssue : un zip vide
    // s'enregistrait, puis l'émission restait bloquée « address » sans erreur visible — le
    // cul-de-sac se rejouait un écran plus loin.
    expect(canSaveLegalIdentity({ ...CURRENT, rcsOrRm: 'RM 92', zip: '' }, VAT_OPTIONAL)).toBe(false);
    expect(canSaveLegalIdentity({ ...CURRENT, rcsOrRm: 'RM 92' }, VAT_OPTIONAL)).toBe(true);
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

  it('exige le capital d’une société : vide ou zéro = champ en erreur (bug FLY SERVICES)', () => {
    const base = { ...CURRENT, rcsOrRm: 'RCS Paris 732 829 320' };
    expect(legalIdentityErrors(base, SOCIETE).capitalSocial).toBe(true);
    expect(canSaveLegalIdentity(base, SOCIETE)).toBe(false);
    expect(legalIdentityErrors({ ...base, capitalSocialEuros: '0' }, SOCIETE).capitalSocial).toBe(true);
    expect(legalIdentityErrors({ ...base, capitalSocialEuros: '-5' }, SOCIETE).capitalSocial).toBe(true);
    expect(legalIdentityErrors({ ...base, capitalSocialEuros: '1,555' }, SOCIETE).capitalSocial).toBe(true);
    expect(legalIdentityErrors({ ...base, capitalSocialEuros: '10 000' }, SOCIETE).capitalSocial).toBe(false);
    expect(canSaveLegalIdentity({ ...base, capitalSocialEuros: '10 000' }, SOCIETE)).toBe(true);
  });

  it('hors société : capital vide accepté, mais une saisie invalide reste une erreur', () => {
    expect(legalIdentityErrors(CURRENT, VAT_OPTIONAL).capitalSocial).toBe(false);
    // Plus strict que le minimum : même sans exigence, « 0 » n'est jamais envoyable au serveur
    // (garde > 0) — le signaler ICI plutôt que d'échouer en réseau.
    expect(
      legalIdentityErrors({ ...CURRENT, capitalSocialEuros: '0' }, VAT_OPTIONAL).capitalSocial,
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
      capitalSocialEuros: '',
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

  it('émet le capital EN CENTIMES quand il est saisi ou corrigé (le déblocage FLY SERVICES)', () => {
    const current = { ...CURRENT, rcsOrRm: 'RCS Paris 732 829 320', tvaIntracom: 'FR44732829320' };
    expect(
      buildLegalIdentityPatch(current, { ...current, capitalSocialEuros: '10 000,50' }, SOCIETE_REEL),
    ).toEqual({ capitalSocialCents: 1_000_050 });
    const withCapital = { ...current, capitalSocialEuros: '10000,00' };
    expect(
      buildLegalIdentityPatch(withCapital, { ...withCapital, capitalSocialEuros: '12 500' }, SOCIETE_REEL),
    ).toEqual({ capitalSocialCents: 1_250_000 });
  });

  it('compare le capital en CENTIMES : re-taper la même somme autrement n’émet rien', () => {
    const withCapital = {
      ...CURRENT,
      rcsOrRm: 'RM 92',
      capitalSocialEuros: '10000,00',
    };
    expect(
      buildLegalIdentityPatch(withCapital, { ...withCapital, capitalSocialEuros: '10 000' }, SOCIETE),
    ).toBeNull();
  });

  it('capital vidé hors exigence = effacement explicite (null), comme la TVA', () => {
    const withCapital = { ...CURRENT, rcsOrRm: 'RM 92', capitalSocialEuros: '5000' };
    expect(
      buildLegalIdentityPatch(withCapital, { ...withCapital, capitalSocialEuros: '' }, VAT_OPTIONAL),
    ).toEqual({ capitalSocialCents: null });
  });

  it('capital requis mais vidé ou invalide = null fail-closed, jamais un patch sans lui', () => {
    const withCapital = { ...CURRENT, rcsOrRm: 'RM 92', capitalSocialEuros: '5000' };
    expect(
      buildLegalIdentityPatch(withCapital, { ...withCapital, capitalSocialEuros: '' }, SOCIETE),
    ).toBeNull();
    expect(
      buildLegalIdentityPatch(withCapital, { ...withCapital, capitalSocialEuros: '0' }, SOCIETE),
    ).toBeNull();
  });
});
