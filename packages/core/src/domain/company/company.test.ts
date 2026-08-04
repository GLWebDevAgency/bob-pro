import { describe, it, expect } from 'vitest';
import { Company, type CompanyProps } from './company';

const baseProps: CompanyProps = {
  id: 'c1',
  name: 'Mercier Plomberie',
  legalForm: 'EI',
  siren: '732829320',
  siret: '73282932000074',
  trade: 'plombier',
  vatRegime: 'reel_simpl',
  address: { line1: '1 rue X', zip: '92000', city: 'Nanterre' },
  rcsOrRm: 'RM 92',
  tvaIntracom: 'FR44732829320',
};

describe('Company', () => {
  it('detecte le BTP et la franchise', () => {
    const r = Company.of(baseProps);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.isBtp()).toBe(true);
      expect(r.value.isVatFranchise()).toBe(false);
    }
  });
  it('franchise => isVatFranchise true', () => {
    const r = Company.of({ ...baseProps, vatRegime: 'franchise' });
    if (r.ok) expect(r.value.isVatFranchise()).toBe(true);
  });
  it('assertCanIssue ok quand identite complete', () => {
    const r = Company.of(baseProps);
    if (r.ok) expect(r.value.assertCanIssue().ok).toBe(true);
  });
  it('issueBlockers liste TOUS les manquants d’un coup — le pré-vol ne fait plus découvrir un par un (audit QA A6)', () => {
    const { rcsOrRm: _rcs, capitalSocialCents: _cap, tvaIntracom: _tva, ...incomplete } = baseProps;
    const r = Company.of({ ...incomplete, legalForm: 'SARL', vatRegime: 'reel_simpl' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.issueBlockers()).toEqual(['rcsOrRm', 'capitalSocialCents', 'tvaIntracom']);
      // Et l'erreur unitaire reste le PREMIER manquant : une seule source de vérité.
      expect(r.value.assertCanIssue()).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION', field: 'rcsOrRm' },
      });
    }
  });
  it('refuse aussi un code postal vide avant émission', () => {
    const r = Company.of({ ...baseProps, address: { line1: '1 rue X', zip: '   ', city: 'Nanterre' } });
    expect(r.ok && r.value.assertCanIssue()).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION', field: 'address' },
    });
  });
  it.each(['EURL', 'SASU', 'SARL', 'SAS'] as const)(
    'refuse l’émission sans capital social pour une %s',
    (legalForm) => {
      const r = Company.of({ ...baseProps, legalForm });
      expect(r.ok && r.value.assertCanIssue()).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION', field: 'capitalSocialCents' },
      });
    },
  );
  it('rejette un SIRET incoherent avec le SIREN', () => {
    const r = Company.of({ ...baseProps, siret: '55208131766522' });
    expect(r.ok).toBe(false);
  });
  it('normalise la TVA réelle et refuse une clé ou un SIREN incohérents', () => {
    const valid = Company.of({ ...baseProps, tvaIntracom: ' fr44 732 829 320 ' });
    expect(valid.ok && valid.value.tvaIntracom).toBe('FR44732829320');
    expect(Company.of({ ...baseProps, tvaIntracom: 'FR24732829320' })).toMatchObject({
      ok: false,
      error: { field: 'tvaIntracom' },
    });
    expect(Company.of({ ...baseProps, tvaIntracom: 'FR96552100554' })).toMatchObject({
      ok: false,
      error: { field: 'tvaIntracom' },
    });
  });
  it('refuse l’émission avec TVA sans numéro réel mais laisse la franchise honnête', () => {
    const { tvaIntracom: _vat, ...withoutVat } = baseProps;
    const standard = Company.of(withoutVat);
    expect(standard.ok && standard.value.assertCanIssue()).toMatchObject({ ok: false, error: { field: 'tvaIntracom' } });
    const franchise = Company.of({ ...withoutVat, vatRegime: 'franchise' });
    expect(franchise.ok && franchise.value.assertCanIssue().ok).toBe(true);
  });
  it('conserve une clientèle confirmée sans en inventer une par défaut', () => {
    const withoutPortfolio = Company.of(baseProps);
    expect(withoutPortfolio.ok && withoutPortfolio.value.customerPortfolio).toBeUndefined();

    const withPortfolio = Company.of({ ...baseProps, customerPortfolio: 'b2g' });
    expect(withPortfolio.ok && withPortfolio.value.customerPortfolio).toBe('b2g');
  });
  it('rejette une clientèle hors contrat à la réhydratation', () => {
    const r = Company.of({ ...baseProps, customerPortfolio: 'particuliers-et-pros' as never });
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION', field: 'customerPortfolio' },
    });
  });
});

describe('Company — capital social (A6, art. R123-238 c. com.)', () => {
  const societeProps: CompanyProps = { ...baseProps, legalForm: 'SARL' };

  it('accepte un capital en centimes entiers > 0 pour une société', () => {
    const r = Company.of({ ...societeProps, capitalSocialCents: 1_000_000 });
    expect(r.ok && r.value.capitalSocialCents).toBe(1_000_000);
    expect(r.ok && r.value.isSociete()).toBe(true);
  });
  it('absent = jamais saisi (aucune valeur inventée)', () => {
    const r = Company.of(societeProps);
    expect(r.ok && r.value.capitalSocialCents).toBeUndefined();
  });
  it.each([0, -100, 12.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejette un capital non entier sûr ou ≤ 0 (%s)',
    (capitalSocialCents) => {
      const r = Company.of({ ...societeProps, capitalSocialCents });
      expect(r).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION', field: 'capitalSocialCents' },
      });
    },
  );
  it.each(['EI', 'micro'] as const)(
    'rejette un capital pour la forme %s (une EI n’a pas de capital social)',
    (legalForm) => {
      const r = Company.of({ ...baseProps, legalForm, capitalSocialCents: 100_000 });
      expect(r).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION', field: 'capitalSocialCents' },
      });
    },
  );
  it('isSociete distingue sociétés à capital et entrepreneurs individuels', () => {
    for (const legalForm of ['EURL', 'SASU', 'SARL', 'SAS'] as const) {
      const r = Company.of({ ...baseProps, legalForm });
      expect(r.ok && r.value.isSociete()).toBe(true);
    }
    for (const legalForm of ['EI', 'micro'] as const) {
      const r = Company.of({ ...baseProps, legalForm });
      expect(r.ok && r.value.isSociete()).toBe(false);
    }
  });
});

describe('Company — médiateur de la consommation (A2, art. L612-1/L616-1 c. conso)', () => {
  it('accepte nom + coordonnées et les restitue par copie défensive', () => {
    const r = Company.of({
      ...baseProps,
      mediateurConso: { nom: 'CM2C', coordonnees: '14 rue Saint-Jean, 75017 Paris — cm2c.net' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const first = r.value.mediateurConso;
      expect(first).toEqual({
        nom: 'CM2C',
        coordonnees: '14 rue Saint-Jean, 75017 Paris — cm2c.net',
      });
      if (first) first.nom = 'FALSIFIÉ';
      expect(r.value.mediateurConso?.nom).toBe('CM2C');
      const props = r.value.toProps();
      if (props.mediateurConso) props.mediateurConso.nom = 'FALSIFIÉ';
      expect(r.value.mediateurConso?.nom).toBe('CM2C');
    }
  });
  it('absent = jamais saisi (nudge onboarding, aucun défaut)', () => {
    const r = Company.of(baseProps);
    expect(r.ok && r.value.mediateurConso).toBeUndefined();
  });
  it.each([
    { nom: '', coordonnees: 'cm2c.net' },
    { nom: '   ', coordonnees: 'cm2c.net' },
    { nom: 'X'.repeat(201), coordonnees: 'cm2c.net' },
    { nom: 'CM2C', coordonnees: '' },
    { nom: 'CM2C', coordonnees: '   ' },
    { nom: 'CM2C', coordonnees: 'X'.repeat(501) },
  ])('rejette un médiateur incomplet ou hors bornes', (mediateurConso) => {
    const r = Company.of({ ...baseProps, mediateurConso });
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION', field: 'mediateurConso' },
    });
  });
});
