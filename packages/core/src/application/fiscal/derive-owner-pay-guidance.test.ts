import { describe, it, expect } from 'vitest';
import { confirmeUtilisateur, hypothese, manquant, type FiscalProfileProps } from '../../domain/fiscal/fiscal-profile';
import { formatEURWhole } from '../../format/money';
import { deriveOwnerPayGuidance, type OwnerPayGuidanceCashflow } from './derive-owner-pay-guidance';

const NOW = '2026-07-15T10:00:00.000Z';

function baseProfile(overrides: Partial<FiscalProfileProps> = {}): FiscalProfileProps {
  return {
    companyId: 'co-1',
    legalForm: manquant(),
    taxRegime: manquant(),
    socialStatus: manquant(),
    activityNature: manquant(),
    vatRegime: manquant(),
    acre: manquant(),
    versementLiberatoire: manquant(),
    fiscalYearEnd: manquant(),
    ...overrides,
  };
}

const CASHFLOW: OwnerPayGuidanceCashflow = { available: 900_000, payout: 500_000, vatDue: 80_000 };

describe('deriveOwnerPayGuidance — fallback prudent (zéro régression)', () => {
  it('taxRegime manquant → prudent, clés ACTUELLES, amount = payout formaté', () => {
    const g = deriveOwnerPayGuidance(baseProfile(), CASHFLOW);
    expect(g.kind).toBe('prudent');
    expect(g.headlineKey).toBe('argent.heroLabel');
    expect(g.captionKey).toBe('argent.heroCaption');
    expect(g.amountCents).toBeUndefined();
    expect(g.params.amount).toBe(formatEURWhole(500_000));
  });

  it('taxRegime hypothèse (dérivée du SIRET, PAS confirmée) → prudent', () => {
    const g = deriveOwnerPayGuidance(baseProfile({ taxRegime: hypothese('micro', NOW, 'derived_legal_form') }), CASHFLOW);
    expect(g.kind).toBe('prudent');
  });

  it('taxRegime confirmé mais statut social encore inconnu (ex. SARL) → prudent', () => {
    const g = deriveOwnerPayGuidance(
      baseProfile({ taxRegime: confirmeUtilisateur('is', NOW, 'user_form'), socialStatus: manquant() }),
      CASHFLOW,
    );
    expect(g.kind).toBe('prudent');
  });

  it('micro confirmé mais periodeCA absent → prudent (rien de calculable sans le CA de la période)', () => {
    const g = deriveOwnerPayGuidance(
      baseProfile({
        taxRegime: confirmeUtilisateur('micro', NOW, 'user_form'),
        activityNature: confirmeUtilisateur('bic_service', NOW, 'user_form'),
      }),
      CASHFLOW,
    );
    expect(g.kind).toBe('prudent');
  });

  it('micro confirmé + periodeCA fourni mais activityNature manquante → prudent', () => {
    const g = deriveOwnerPayGuidance(
      baseProfile({ taxRegime: confirmeUtilisateur('micro', NOW, 'user_form') }),
      CASHFLOW,
      { encaissedCents: 1_000_000, year: 2026 },
    );
    expect(g.kind).toBe('prudent');
  });
});

describe('deriveOwnerPayGuidance — micro confirmé (kind micro_retrait_prudent)', () => {
  it('bic_service (21,2 % en 2026) : retrait = payout − provision, ratePct exposé, pas d’ACRE', () => {
    const g = deriveOwnerPayGuidance(
      baseProfile({
        taxRegime: confirmeUtilisateur('micro', NOW, 'user_form'),
        activityNature: confirmeUtilisateur('bic_service', NOW, 'user_form'),
      }),
      CASHFLOW,
      { encaissedCents: 1_000_000, year: 2026 },
    );
    expect(g.kind).toBe('micro_retrait_prudent');
    expect(g.headlineKey).toBe('fiscal.guidance.microRetraitPrudent.headline');
    expect(g.captionKey).toBe('fiscal.guidance.microRetraitPrudent.caption');
    // 10 000 € × 21,2 % = 2 120 € de provision → 5 000 − 2 120 = 2 880 €
    expect(g.amountCents).toBe(288_000);
    expect(g.params.amount).toBe(formatEURWhole(288_000));
    expect(g.params.ratePct).toBe('21,2');
    expect(g.params.acreNote).toBe('');
  });

  it('activityNature en simple hypothèse (pas confirmée) reste utilisable — même précédent que deriveUrssafProvision', () => {
    const g = deriveOwnerPayGuidance(
      baseProfile({
        taxRegime: confirmeUtilisateur('micro', NOW, 'user_form'),
        activityNature: hypothese('bic_service', NOW, 'derived_trade'),
      }),
      CASHFLOW,
      { encaissedCents: 1_000_000, year: 2026 },
    );
    expect(g.kind).toBe('micro_retrait_prudent');
    expect(g.amountCents).toBe(288_000);
  });

  it('bnc (25,6 % en 2026)', () => {
    const g = deriveOwnerPayGuidance(
      baseProfile({
        taxRegime: confirmeUtilisateur('micro', NOW, 'user_form'),
        activityNature: confirmeUtilisateur('bnc', NOW, 'user_form'),
      }),
      CASHFLOW,
      { encaissedCents: 1_000_000, year: 2026 },
    );
    expect(g.params.ratePct).toBe('25,6');
    expect(g.amountCents).toBe(500_000 - 256_000);
  });

  it('bnc_cipav (23,2 %)', () => {
    const g = deriveOwnerPayGuidance(
      baseProfile({
        taxRegime: confirmeUtilisateur('micro', NOW, 'user_form'),
        activityNature: confirmeUtilisateur('bnc_cipav', NOW, 'user_form'),
      }),
      CASHFLOW,
      { encaissedCents: 1_000_000, year: 2026 },
    );
    expect(g.params.ratePct).toBe('23,2');
    expect(g.amountCents).toBe(500_000 - 232_000);
  });

  it('mixte → catégorie la plus chère (bnc, prudence, même politique que microCategoryFromTrade)', () => {
    const g = deriveOwnerPayGuidance(
      baseProfile({
        taxRegime: confirmeUtilisateur('micro', NOW, 'user_form'),
        activityNature: confirmeUtilisateur('mixte', NOW, 'user_form'),
      }),
      CASHFLOW,
      { encaissedCents: 1_000_000, year: 2026 },
    );
    expect(g.params.ratePct).toBe('25,6');
  });

  it('versement libératoire additif (bic_vente 12,3 % + 1 % = 13,3 %)', () => {
    const g = deriveOwnerPayGuidance(
      baseProfile({
        taxRegime: confirmeUtilisateur('micro', NOW, 'user_form'),
        activityNature: confirmeUtilisateur('bic_vente', NOW, 'user_form'),
        versementLiberatoire: confirmeUtilisateur(true, NOW, 'user_form'),
      }),
      CASHFLOW,
      { encaissedCents: 1_000_000, year: 2026 },
    );
    expect(g.params.ratePct).toBe('13,3');
    // 10 000 € × 13,3 % = 1 330 € → 5 000 − 1 330 = 3 670 €
    expect(g.amountCents).toBe(367_000);
  });

  it('plancher 0 : provision supérieure au payout → retrait 0, jamais négatif', () => {
    const g = deriveOwnerPayGuidance(
      baseProfile({
        taxRegime: confirmeUtilisateur('micro', NOW, 'user_form'),
        activityNature: confirmeUtilisateur('bnc', NOW, 'user_form'),
      }),
      { available: 200_000, payout: 100_000, vatDue: 0 },
      { encaissedCents: 1_000_000, year: 2026 },
    );
    expect(g.amountCents).toBe(0);
  });

  it('ACRE accordée (confirmée) : taux TOUJOURS plein (jamais de réduction devinée), acreNote non vide', () => {
    const g = deriveOwnerPayGuidance(
      baseProfile({
        taxRegime: confirmeUtilisateur('micro', NOW, 'user_form'),
        activityNature: confirmeUtilisateur('bic_service', NOW, 'user_form'),
        acre: confirmeUtilisateur({ granted: true, startDate: '2026-03-15' }, NOW, 'user_form'),
      }),
      CASHFLOW,
      { encaissedCents: 1_000_000, year: 2026 },
    );
    expect(g.params.ratePct).toBe('21,2'); // taux plein, pas 10,6 (moitié ACRE)
    expect(g.amountCents).toBe(288_000);
    expect(typeof g.params.acreNote).toBe('string');
    expect((g.params.acreNote as string).length).toBeGreaterThan(0);
  });

  it('ACRE en simple hypothèse (granted true, non confirmée) : acreNote quand même affichée', () => {
    const g = deriveOwnerPayGuidance(
      baseProfile({
        taxRegime: confirmeUtilisateur('micro', NOW, 'user_form'),
        activityNature: confirmeUtilisateur('bic_service', NOW, 'user_form'),
        acre: hypothese({ granted: true }, NOW, 'derived_legal_form'),
      }),
      CASHFLOW,
      { encaissedCents: 1_000_000, year: 2026 },
    );
    expect((g.params.acreNote as string).length).toBeGreaterThan(0);
  });

  it('ACRE explicitement refusée → acreNote vide', () => {
    const g = deriveOwnerPayGuidance(
      baseProfile({
        taxRegime: confirmeUtilisateur('micro', NOW, 'user_form'),
        activityNature: confirmeUtilisateur('bic_service', NOW, 'user_form'),
        acre: confirmeUtilisateur({ granted: false }, NOW, 'user_form'),
      }),
      CASHFLOW,
      { encaissedCents: 1_000_000, year: 2026 },
    );
    expect(g.params.acreNote).toBe('');
  });

  it('versementLiberatoire manquant → traité comme non pris (comme deriveUrssafProvision)', () => {
    const g = deriveOwnerPayGuidance(
      baseProfile({
        taxRegime: confirmeUtilisateur('micro', NOW, 'user_form'),
        activityNature: confirmeUtilisateur('bic_service', NOW, 'user_form'),
        versementLiberatoire: manquant(),
      }),
      CASHFLOW,
      { encaissedCents: 1_000_000, year: 2026 },
    );
    expect(g.params.ratePct).toBe('21,2');
  });
});

describe('deriveOwnerPayGuidance — assimilé salarié confirmé (kind salaire_a_simuler)', () => {
  it('SASU/SAS (socialStatus confirmé assimile_salarie) : montant INCHANGÉ (payout), pas de net inventé', () => {
    const g = deriveOwnerPayGuidance(
      baseProfile({
        taxRegime: confirmeUtilisateur('is', NOW, 'user_form'),
        socialStatus: confirmeUtilisateur('assimile_salarie', NOW, 'user_form'),
      }),
      CASHFLOW,
    );
    expect(g.kind).toBe('salaire_a_simuler');
    expect(g.headlineKey).toBe('fiscal.guidance.salaireASimuler.headline');
    expect(g.captionKey).toBe('fiscal.guidance.salaireASimuler.caption');
    expect(g.amountCents).toBeUndefined(); // jamais un net inventé
    expect(g.params.amount).toBe(formatEURWhole(500_000));
  });

  it('socialStatus assimile_salarie en simple hypothèse (pas confirmée) → prudent, pas salaire_a_simuler', () => {
    const g = deriveOwnerPayGuidance(
      baseProfile({
        taxRegime: confirmeUtilisateur('is', NOW, 'user_form'),
        socialStatus: hypothese('assimile_salarie', NOW, 'derived_legal_form'),
      }),
      CASHFLOW,
    );
    expect(g.kind).toBe('prudent');
  });
});

describe('deriveOwnerPayGuidance — TNS réel confirmé (kind prelevement_apres_provisions)', () => {
  it('EI réel / EURL (socialStatus confirmé tns, régime non micro) : montant INCHANGÉ', () => {
    const g = deriveOwnerPayGuidance(
      baseProfile({
        taxRegime: confirmeUtilisateur('reel_ir', NOW, 'user_form'),
        socialStatus: confirmeUtilisateur('tns', NOW, 'user_form'),
      }),
      CASHFLOW,
    );
    expect(g.kind).toBe('prelevement_apres_provisions');
    expect(g.headlineKey).toBe('fiscal.guidance.prelevementApresProvisions.headline');
    expect(g.captionKey).toBe('fiscal.guidance.prelevementApresProvisions.caption');
    expect(g.amountCents).toBeUndefined();
    expect(g.params.amount).toBe(formatEURWhole(500_000));
  });

  it('EURL à l’IS, TNS confirmé (gérant associé unique) : même kind, régime IS n’implique pas micro', () => {
    const g = deriveOwnerPayGuidance(
      baseProfile({
        taxRegime: confirmeUtilisateur('is', NOW, 'user_form'),
        socialStatus: confirmeUtilisateur('tns', NOW, 'user_form'),
      }),
      CASHFLOW,
    );
    expect(g.kind).toBe('prelevement_apres_provisions');
  });
});

describe('deriveOwnerPayGuidance — jamais de dividendes mensuels en 1C', () => {
  it('aucun kind du résultat ne mentionne des dividendes', () => {
    const kinds = ['prudent', 'micro_retrait_prudent', 'salaire_a_simuler', 'prelevement_apres_provisions'];
    for (const k of kinds) expect(k).not.toMatch(/dividende/i);
  });
});
